"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as ort from "onnxruntime-web"; // ONNX Runtime for running ML models in the browser
import {
  CLASS_NAMES, // Array of object class names (e.g., ["person", "car", "dog"])
  MODEL_PATH, // Path to the YOLO model file
  CONFIDENCE_THRESHOLD, // Minimum confidence to show a detection (e.g., 0.5 = 50%)
  INPUT_SIZE, // Model input size (usually 640x640 for YOLO)
} from "@/lib/constants";

/**
 * INFERENCE_INTERVAL_MS controls how often we run object detection.
 * Running inference every frame (60fps) would be too slow, so we throttle it.
 * 500ms = 2 times per second, which is fast enough to feel responsive.
 */
const INFERENCE_INTERVAL_MS = 500;

/**
 * Detection represents a single object detected by YOLO.
 * Each detection contains information about what was found and where.
 */
interface Detection {
  classId: number; // Numeric ID of the class (e.g., 0 = person, 1 = bicycle)
  className: string; // Human-readable name (e.g., "person")
  confidence: number; // How confident the model is (0.0 to 1.0)
  bbox: [number, number, number, number]; // Bounding box: [x, y, width, height] in pixels
}

/**
 * preprocessImage converts a canvas image into the format YOLO expects.
 *
 * YOLO needs:
 * 1. Specific size (INPUT_SIZE x INPUT_SIZE, usually 640x640)
 * 2. Normalized values (0-1 instead of 0-255)
 * 3. Channel-first format (all reds, then all greens, then all blues)
 *
 * @param ctx - Canvas context containing the image to process
 * @returns Float32Array ready for YOLO model input
 */
const preprocessImage = (ctx: CanvasRenderingContext2D): Float32Array => {
  // Get pixel data from canvas (RGBA format: [r,g,b,a, r,g,b,a, ...])
  const imageData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = imageData; // Raw pixel data (0-255 values)

  // Create array for model input (3 channels × width × height)
  const input = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const pixelCount = INPUT_SIZE * INPUT_SIZE;

  // Convert from interleaved RGBA to planar RGB and normalize
  // Canvas gives us: [R,G,B,A, R,G,B,A, ...]
  // YOLO wants: [R,R,R,..., G,G,G,..., B,B,B,...]
  for (let i = 0; i < data.length; i += 4) {
    const idx = i / 4; // Pixel index (0, 1, 2, ...)
    input[idx] = data[i] / 255.0; // Red channel
    input[pixelCount + idx] = data[i + 1] / 255.0; // Green channel
    input[2 * pixelCount + idx] = data[i + 2] / 255.0; // Blue channel
    // Note: We skip Alpha (data[i + 3]) because YOLO doesn't use it
  }

  return input;
};

/**
 * processOutput converts raw YOLO model output into Detection objects.
 *
 * YOLO outputs 8400 potential detections with:
 * - Bounding box coordinates (x, y, w, h)
 * - Confidence scores for each possible class
 *
 * We filter these to only keep high-confidence detections.
 *
 * @param output - Raw model output array
 * @param imgWidth - Width of the displayed image
 * @param imgHeight - Height of the displayed image
 * @returns Array of Detection objects
 */
const processOutput = (
  output: Float32Array,
  imgWidth: number,
  imgHeight: number
): Detection[] => {
  const detections: Detection[] = [];
  const numDetections = 8400; // YOLO outputs 8400 potential detections
  const numClasses = CLASS_NAMES.length;

  // Loop through all 8400 potential detections
  for (let i = 0; i < numDetections; i++) {
    // Extract bounding box coordinates (center x, center y, width, height)
    // YOLO output is organized as: [all x values, all y values, all w values, all h values, ...]
    const x = output[i];
    const y = output[numDetections + i];
    const w = output[2 * numDetections + i];
    const h = output[3 * numDetections + i];

    // Find which class has the highest confidence score for this detection
    let maxScore = 0;
    let classId = 0;
    for (let j = 0; j < numClasses; j++) {
      // Class scores start after the 4 bounding box values
      const score = output[(4 + j) * numDetections + i];
      if (score > maxScore) {
        maxScore = score;
        classId = j;
      }
    }

    // Only keep detections above our confidence threshold
    if (maxScore > CONFIDENCE_THRESHOLD) {
      detections.push({
        classId,
        className: CLASS_NAMES[classId] || `Class ${classId}`,
        confidence: maxScore,
        bbox: [
          // Convert from center coordinates to top-left coordinates
          // Also scale from model size (INPUT_SIZE) to display size (imgWidth/imgHeight)
          ((x - w / 2) * imgWidth) / INPUT_SIZE, // x (left edge)
          ((y - h / 2) * imgHeight) / INPUT_SIZE, // y (top edge)
          (w * imgWidth) / INPUT_SIZE, // width
          (h * imgHeight) / INPUT_SIZE, // height
        ],
      });
    }
  }

  return detections;
};

/**
 * drawDetections renders bounding boxes and labels on the canvas.
 *
 * For each detection, we draw:
 * 1. A green rectangle around the object
 * 2. A label showing the class name and confidence percentage
 *
 * @param ctx - Canvas context to draw on
 * @param detections - Array of detections to visualize
 */
const drawDetections = (
  ctx: CanvasRenderingContext2D,
  detections: Detection[]
) => {
  detections.forEach(({ bbox, className, confidence }) => {
    const [x, y, w, h] = bbox;

    // Draw the bounding box (green rectangle)
    ctx.strokeStyle = "#00FF00"; // Bright green
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);

    // Create label text (e.g., "person 87.3%")
    const label = `${className} ${(confidence * 100).toFixed(1)}%`;
    ctx.font = "18px Arial";
    const textWidth = ctx.measureText(label).width;

    // Draw background rectangle for the label (green)
    // Position it above the box if possible, otherwise inside
    ctx.fillStyle = "#00FF00";
    ctx.fillRect(x, y > 25 ? y - 25 : y, textWidth + 10, 25);

    // Draw the label text (black text on green background)
    ctx.fillStyle = "#000000";
    ctx.fillText(label, x + 5, y > 25 ? y - 7 : y + 18);
  });
};

/**
 * CameraFeed component displays a live camera feed with object detection.
 *
 * Architecture:
 * 1. Load YOLO model on mount
 * 2. Request camera access
 * 3. Continuously draw video frames to canvas
 * 4. Periodically run object detection (throttled for performance)
 * 5. Draw bounding boxes over detected objects
 */
const CameraFeed = () => {
  // ========== DOM REFERENCES ==========
  // These refs give us access to DOM elements without causing re-renders
  const videoRef = useRef<HTMLVideoElement | null>(null); // Hidden video element receiving camera stream
  const canvasRef = useRef<HTMLCanvasElement | null>(null); // Visible canvas where we draw video + detections
  const tempCanvasRef = useRef<HTMLCanvasElement | null>(null); // Temporary canvas for resizing images before inference

  // ========== STATE ==========
  const [session, setSession] = useState<ort.InferenceSession | null>(null); // ONNX model session
  const [isLoading, setIsLoading] = useState(true); // True while model is loading
  const [error, setError] = useState<string | null>(null); // Error message if model fails to load

  // ========== PERFORMANCE TRACKING ==========
  const animationFrameId = useRef<number | null>(null); // ID for canceling animation loop
  const lastInferenceTime = useRef<number>(0); // Timestamp of last inference (for throttling)
  const isInferring = useRef<boolean>(false); // Prevents running multiple inferences simultaneously

  // ========== EFFECT 1: LOAD YOLO MODEL ==========
  // This runs once when the component mounts
  useEffect(() => {
    const loadModel = async () => {
      try {
        setIsLoading(true);

        // Fetch the ONNX model file from the public directory
        console.log("📥 Fetching model from:", MODEL_PATH);
        const response = await fetch(MODEL_PATH);

        if (!response.ok) {
          throw new Error(
            `Failed to fetch model: ${response.status} ${response.statusText}`
          );
        }

        // Get the model as binary data (ArrayBuffer)
        const modelBuffer = await response.arrayBuffer();
        console.log("📦 Model size:", modelBuffer.byteLength, "bytes");

        // Create an ONNX Runtime session to run the model
        // We use WebAssembly (wasm) for CPU-based inference in the browser
        const modelSession = await ort.InferenceSession.create(modelBuffer, {
          executionProviders: ["wasm"],
        });

        // Store the session in state so we can use it for inference
        setSession(modelSession);
        setIsLoading(false);
        console.log("✅ Model loaded successfully");
        console.log("📋 Input names:", modelSession.inputNames);
        console.log("📋 Output names:", modelSession.outputNames);
      } catch (err) {
        console.error("❌ Error loading model:", err);
        setError(
          "Failed to load model. Make sure best.onnx is in public/models/ and is a valid ONNX file."
        );
        setIsLoading(false);
      }
    };

    loadModel();
  }, []); // Empty dependency array = run once on mount

  // ========== EFFECT 2: SET UP CAMERA ==========
  // This requests camera permission and starts the video stream
  useEffect(() => {
    const getCameraFeed = async () => {
      try {
        // Request access to the user's camera
        // This will prompt the user for permission if not already granted
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true, // We only need video, not audio
        });

        // Connect the camera stream to our hidden video element
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (error) {
        console.error("Error accessing the camera", error);
        // User might have denied permission or camera might not be available
      }
    };

    getCameraFeed();

    // Cleanup function: runs when component unmounts
    return () => {
      // Stop the camera stream to release the camera
      if (videoRef.current) {
        const stream = videoRef.current.srcObject as MediaStream;
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
        }
      }

      // Cancel any pending animation frames
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, []); // Empty dependency array = run once on mount

  // ========== EFFECT 3: INITIALIZE TEMP CANVAS ==========
  // Create a temporary canvas for preprocessing images before inference
  useEffect(() => {
    // This canvas is never displayed - it's just for resizing images
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = INPUT_SIZE; // Set to model's expected input size
    tempCanvas.height = INPUT_SIZE;
    tempCanvasRef.current = tempCanvas;
  }, []); // Empty dependency array = run once on mount

  // ========== DETECTION STORAGE ==========
  // Store the latest detections so we can redraw them every frame
  // even when we're not running inference (for smooth animation)
  const detectionsRef = useRef<Detection[]>([]);

  // ========== MAIN DETECTION LOOP ==========
  /**
   * detectObjects is the heart of the component. It runs continuously using requestAnimationFrame.
   *
   * On every frame:
   * 1. Draw the video feed to the canvas (60fps for smooth video)
   * 2. Every 500ms, run object detection on the current frame
   * 3. Draw bounding boxes over detected objects
   *
   * This separation allows smooth video even though inference is slow.
   */
  const detectObjects = useCallback(async () => {
    // Wait if model or elements aren't ready yet
    if (!session || !videoRef.current || !canvasRef.current) {
      animationFrameId.current = requestAnimationFrame(detectObjects);
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    // Wait if video hasn't loaded enough data yet
    if (!ctx || video.readyState !== video.HAVE_ENOUGH_DATA) {
      animationFrameId.current = requestAnimationFrame(detectObjects);
      return;
    }

    // Match canvas size to video size (only update if changed)
    if (
      canvas.width !== video.videoWidth ||
      canvas.height !== video.videoHeight
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    // ========== STEP 1: DRAW VIDEO FRAME ==========
    // Draw the current video frame to canvas (mirrored horizontally for selfie effect)
    // This happens every frame for smooth 60fps video
    ctx.save(); // Save current canvas state
    ctx.scale(-1, 1); // Flip horizontally
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore(); // Restore canvas state

    // ========== STEP 2: RUN INFERENCE (THROTTLED) ==========
    // Only run object detection every INFERENCE_INTERVAL_MS (500ms)
    // This is much slower than video rendering but fast enough to feel responsive
    const now = performance.now();
    const shouldRunInference =
      !isInferring.current && // Don't start new inference if one is already running
      now - lastInferenceTime.current >= INFERENCE_INTERVAL_MS; // Wait 500ms between inferences

    if (shouldRunInference && tempCanvasRef.current) {
      isInferring.current = true; // Mark that inference is running
      lastInferenceTime.current = now; // Record when we started

      try {
        const tempCtx = tempCanvasRef.current.getContext("2d");

        if (tempCtx) {
          // Resize the current video frame to model's expected input size
          tempCtx.drawImage(video, 0, 0, INPUT_SIZE, INPUT_SIZE);

          // Convert image to model input format (normalized, channel-first RGB)
          const input = preprocessImage(tempCtx);

          // Create ONNX tensor with correct shape: [batch, channels, height, width]
          const tensor = new ort.Tensor("float32", input, [
            1, // Batch size (we process 1 image at a time)
            3, // Channels (RGB)
            INPUT_SIZE, // Height
            INPUT_SIZE, // Width
          ]);

          // Run the model
          const feeds = { images: tensor }; // YOLO expects input named "images"
          const results = await session.run(feeds);
          const output = results.output0.data as Float32Array; // Get raw output

          // Convert raw output to Detection objects
          detectionsRef.current = processOutput(
            output,
            canvas.width,
            canvas.height
          );
        }
      } catch (err) {
        console.error("Detection error:", err);
      } finally {
        isInferring.current = false; // Mark that inference is complete
      }
    }

    // ========== STEP 3: DRAW DETECTIONS ==========
    // Always draw the latest detections (even between inference runs)
    // This ensures smooth animation - boxes stay visible at 60fps even though
    // inference only runs at 2fps
    if (detectionsRef.current.length > 0) {
      // Mirror the x-coordinates because our video is mirrored
      const mirroredDetections: Detection[] = detectionsRef.current.map(
        (d) => ({
          ...d,
          bbox: [
            canvas.width - d.bbox[0] - d.bbox[2], // Flip x coordinate
            d.bbox[1], // Keep y the same
            d.bbox[2], // Keep width the same
            d.bbox[3], // Keep height the same
          ] as [number, number, number, number],
        })
      );
      drawDetections(ctx, mirroredDetections);
    }

    // Schedule the next frame
    // This creates a continuous loop running at ~60fps
    animationFrameId.current = requestAnimationFrame(detectObjects);
  }, [session]); // Re-create callback if session changes

  // ========== EFFECT 4: START DETECTION LOOP ==========
  // This effect starts the detection loop once the model and video are ready
  useEffect(() => {
    if (!session || !videoRef.current) return;

    const video = videoRef.current;

    const startDetection = () => {
      // Only start if not already running
      if (!animationFrameId.current) {
        detectObjects(); // Kick off the continuous loop
      }
    };

    // If video is already ready, start immediately
    if (video.readyState >= video.HAVE_ENOUGH_DATA) {
      startDetection();
    } else {
      // Otherwise wait for video to be ready
      video.addEventListener("loadeddata", startDetection);
    }

    // Cleanup: remove event listener when component unmounts
    return () => {
      video.removeEventListener("loadeddata", startDetection);
    };
  }, [session, detectObjects]); // Run when session or detectObjects changes

  // ========== RENDER ==========
  return (
    <div className="relative">
      {/* Loading overlay - shown while model is loading */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 z-10 rounded-lg">
          <p className="text-white text-xl">Loading model...</p>
        </div>
      )}

      {/* Error overlay - shown if model fails to load */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-500 bg-opacity-90 z-10 rounded-lg">
          <p className="text-white text-center px-4">{error}</p>
        </div>
      )}

      {/* Hidden video element - receives camera stream but isn't displayed */}
      <video ref={videoRef} autoPlay playsInline className="hidden" />

      {/* Visible canvas - displays video with detection overlays */}
      <canvas ref={canvasRef} style={{ width: "100%", height: "auto" }} />
    </div>
  );
};

export default CameraFeed;
