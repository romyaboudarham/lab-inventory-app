"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as ort from 'onnxruntime-web';
import { CLASS_NAMES, MODEL_PATH, CONFIDENCE_THRESHOLD, INPUT_SIZE } from '@/lib/constants';

// Throttle inference to ~10 FPS for performance
const INFERENCE_INTERVAL_MS = 100;

// Detection type
interface Detection {
  classId: number;
  className: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x, y, width, height]
}

// Preprocess image for YOLO (outside component - doesn't need state)
const preprocessImage = (ctx: CanvasRenderingContext2D): Float32Array => {
  const imageData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = imageData;
  const input = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const pixelCount = INPUT_SIZE * INPUT_SIZE;

  // Single pass through pixels
  for (let i = 0; i < data.length; i += 4) {
    const idx = i / 4;
    input[idx] = data[i] / 255.0;                    // R
    input[pixelCount + idx] = data[i + 1] / 255.0;   // G
    input[2 * pixelCount + idx] = data[i + 2] / 255.0; // B
  }

  return input;
};

// Process YOLO output (outside component - doesn't need state)
const processOutput = (
  output: Float32Array, 
  imgWidth: number, 
  imgHeight: number
): Detection[] => {
  const detections: Detection[] = [];
  const numDetections = 8400;
  const numClasses = CLASS_NAMES.length;

  for (let i = 0; i < numDetections; i++) {
    const x = output[i];
    const y = output[numDetections + i];
    const w = output[2 * numDetections + i];
    const h = output[3 * numDetections + i];

    // Find max class score
    let maxScore = 0;
    let classId = 0;
    for (let j = 0; j < numClasses; j++) {
      const score = output[(4 + j) * numDetections + i];
      if (score > maxScore) {
        maxScore = score;
        classId = j;
      }
    }

    if (maxScore > CONFIDENCE_THRESHOLD) {
      detections.push({
        classId,
        className: CLASS_NAMES[classId] || `Class ${classId}`,
        confidence: maxScore,
        bbox: [
          (x - w / 2) * imgWidth / INPUT_SIZE,
          (y - h / 2) * imgHeight / INPUT_SIZE,
          w * imgWidth / INPUT_SIZE,
          h * imgHeight / INPUT_SIZE
        ]
      });
    }
  }

  return detections;
};

// Draw detections on canvas (outside component - doesn't need state)
const drawDetections = (ctx: CanvasRenderingContext2D, detections: Detection[]) => {
  detections.forEach(({ bbox, className, confidence }) => {
    const [x, y, w, h] = bbox;

    ctx.strokeStyle = '#00FF00';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);

    const label = `${className} ${(confidence * 100).toFixed(1)}%`;
    ctx.font = '18px Arial';
    const textWidth = ctx.measureText(label).width;

    ctx.fillStyle = '#00FF00';
    ctx.fillRect(x, y > 25 ? y - 25 : y, textWidth + 10, 25);

    ctx.fillStyle = '#000000';
    ctx.fillText(label, x + 5, y > 25 ? y - 7 : y + 18);
  });
};

const CameraFeed = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tempCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [session, setSession] = useState<ort.InferenceSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const animationFrameId = useRef<number | null>(null);
  const lastInferenceTime = useRef<number>(0);
  const isInferring = useRef<boolean>(false);

  // Load YOLO model
  useEffect(() => {
    const loadModel = async () => {
      try {
        setIsLoading(true);
        
        // Fetch the model as ArrayBuffer first to avoid parsing issues
        console.log("📥 Fetching model from:", MODEL_PATH);
        const response = await fetch(MODEL_PATH);
        
        if (!response.ok) {
          throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
        }
        
        const modelBuffer = await response.arrayBuffer();
        console.log("📦 Model size:", modelBuffer.byteLength, "bytes");
        
        // Create session from ArrayBuffer
        const modelSession = await ort.InferenceSession.create(modelBuffer, {
          executionProviders: ['wasm'],
        });
        
        setSession(modelSession);
        setIsLoading(false);
        console.log("✅ Model loaded successfully");
        console.log("📋 Input names:", modelSession.inputNames);
        console.log("📋 Output names:", modelSession.outputNames);
      } catch (err) {
        console.error("❌ Error loading model:", err);
        setError("Failed to load model. Make sure best.onnx is in public/models/ and is a valid ONNX file.");
        setIsLoading(false);
      }
    };

    loadModel();
  }, []);

  // Set up camera
  useEffect(() => {
    const getCameraFeed = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (error) {
        console.error("Error accessing the camera", error);
      }
    };

    getCameraFeed();

    return () => {
      if (videoRef.current) {
        const stream = videoRef.current.srcObject as MediaStream;
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
        }
      }

      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, []);

  // Initialize temp canvas once
  useEffect(() => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = INPUT_SIZE;
    tempCanvas.height = INPUT_SIZE;
    tempCanvasRef.current = tempCanvas;
  }, []);

  // Store latest detections to persist between frames
  const detectionsRef = useRef<Detection[]>([]);

  // Main detection loop - throttled for performance
  const detectObjects = useCallback(async () => {
    if (!session || !videoRef.current || !canvasRef.current) {
      animationFrameId.current = requestAnimationFrame(detectObjects);
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    if (!ctx || video.readyState !== video.HAVE_ENOUGH_DATA) {
      animationFrameId.current = requestAnimationFrame(detectObjects);
      return;
    }

    // Set canvas size only if changed
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    // Draw mirrored video frame (always, for smooth video)
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();

    // Throttle inference - only run every INFERENCE_INTERVAL_MS
    const now = performance.now();
    const shouldRunInference = 
      !isInferring.current && 
      (now - lastInferenceTime.current) >= INFERENCE_INTERVAL_MS;

    if (shouldRunInference && tempCanvasRef.current) {
      isInferring.current = true;
      lastInferenceTime.current = now;

      try {
        const tempCtx = tempCanvasRef.current.getContext('2d');

        if (tempCtx) {
          tempCtx.drawImage(video, 0, 0, INPUT_SIZE, INPUT_SIZE);
          const input = preprocessImage(tempCtx);
          const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);

          const feeds = { images: tensor };
          const results = await session.run(feeds);
          const output = results.output0.data as Float32Array;

          detectionsRef.current = processOutput(output, canvas.width, canvas.height);
        }
      } catch (err) {
        console.error("Detection error:", err);
      } finally {
        isInferring.current = false;
      }
    }

    // Always draw the latest detections (even between inference runs)
    // Mirror the x-coordinates since video is mirrored
    if (detectionsRef.current.length > 0) {
      const mirroredDetections: Detection[] = detectionsRef.current.map(d => ({
        ...d,
        bbox: [
          canvas.width - d.bbox[0] - d.bbox[2], // mirror x
          d.bbox[1],
          d.bbox[2],
          d.bbox[3]
        ] as [number, number, number, number]
      }));
      drawDetections(ctx, mirroredDetections);
    }

    animationFrameId.current = requestAnimationFrame(detectObjects);
  }, [session]);

  // Start detection when model and video are ready
  useEffect(() => {
    if (!session || !videoRef.current) return;

    const video = videoRef.current;

    const startDetection = () => {
      // Only start if not already running
      if (!animationFrameId.current) {
        detectObjects();
      }
    };

    // If video is already ready, start immediately
    if (video.readyState >= video.HAVE_ENOUGH_DATA) {
      startDetection();
    } else {
      // Otherwise wait for video to be ready
      video.addEventListener('loadeddata', startDetection);
    }

    return () => {
      video.removeEventListener('loadeddata', startDetection);
    };
  }, [session, detectObjects]);

  return (
    <div className="relative">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 z-10 rounded-lg">
          <p className="text-white text-xl">Loading model...</p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-500 bg-opacity-90 z-10 rounded-lg">
          <p className="text-white text-center px-4">{error}</p>
        </div>
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="hidden"
      />
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "auto" }}
      />
    </div>
  );
};

export default CameraFeed;
