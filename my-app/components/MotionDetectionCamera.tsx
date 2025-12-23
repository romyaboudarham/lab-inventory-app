"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as ort from "onnxruntime-web";
import { CLASS_NAMES, MODEL_PATH, CONFIDENCE_THRESHOLD, INPUT_SIZE } from "@/lib/constants";

// ========== CONFIGURATION ==========
const INFERENCE_INTERVAL_MS = 500;      // How often to run YOLO inference (ms)
const MOTION_CHECK_INTERVAL_MS = 200;   // How often to check for motion (ms)
const BRIGHTNESS_THRESHOLD = 15;        // Brightness change needed to trigger (0-255)
const MODEL_DURATION_MS = 3000;         // How long model stays on after motion (ms)
const ROI_SIZE = 0.4;                   // Region of interest size (40% of video)

interface Detection {
  className: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x, y, width, height]
}

/**
 * MotionDetectionCamera - Camera with motion-triggered object detection.
 * 
 * Flow:
 * 1. Model starts disabled, showing smooth video with ROI overlay
 * 2. When brightness changes in ROI, model enables for 3 seconds
 * 3. During scanning, YOLO detects objects and draws bounding boxes
 * 4. After 3 seconds, returns to motion detection mode
 */
const MotionDetectionCamera = () => {
  // ========== REFS ==========
  const videoRef = useRef<HTMLVideoElement>(null);           // Camera video element
  const canvasRef = useRef<HTMLCanvasElement>(null);         // Canvas for drawing detections
  const tempCanvasRef = useRef<HTMLCanvasElement | null>(null);    // Temp canvas for preprocessing
  const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);  // Temp canvas for motion detection
  const detectionsRef = useRef<Detection[]>([]);             // Current detections
  const animationFrameId = useRef<number | null>(null);      // Animation frame ID for cleanup
  const lastInferenceTime = useRef(0);                       // Throttle inference
  const isInferring = useRef(false);                         // Prevent concurrent inference
  const prevBrightness = useRef<number | null>(null);        // Previous brightness for comparison
  const lastMotionCheck = useRef(0);                         // Throttle motion checks
  const modelTimeout = useRef<NodeJS.Timeout | null>(null);  // Auto-disable timer

  // ========== STATE ==========
  const [session, setSession] = useState<ort.InferenceSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modelEnabled, setModelEnabled] = useState(false);   // Start with model disabled

  // ========== SETUP: Load model, camera, and canvases ==========
  useEffect(() => {
    // Load YOLO model
    (async () => {
      try {
        const res = await fetch(MODEL_PATH);
        if (!res.ok) throw new Error("Failed to fetch model");
        const buffer = await res.arrayBuffer();
        const sess = await ort.InferenceSession.create(buffer, { executionProviders: ["wasm"] });
        setSession(sess);
      } catch {
        setError("Failed to load model.");
      } finally {
        setIsLoading(false);
      }
    })();

    // Setup camera
    navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => {
      if (videoRef.current) videoRef.current.srcObject = stream;
    });

    // Create offscreen canvases for preprocessing
    tempCanvasRef.current = Object.assign(document.createElement("canvas"), { width: INPUT_SIZE, height: INPUT_SIZE });
    motionCanvasRef.current = Object.assign(document.createElement("canvas"), { width: 100, height: 100 });

    // Cleanup on unmount
    return () => {
      const stream = videoRef.current?.srcObject as MediaStream;
      stream?.getTracks().forEach((t) => t.stop());
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      if (modelTimeout.current) clearTimeout(modelTimeout.current);
    };
  }, []);

  // ========== MOTION DETECTION: Check brightness change in ROI ==========
  const checkMotion = useCallback(() => {
    const video = videoRef.current, ctx = motionCanvasRef.current?.getContext("2d");
    if (!video || !ctx || video.readyState !== 4) return false;

    // Calculate ROI (centered square)
    const size = Math.min(video.videoWidth, video.videoHeight) * ROI_SIZE;
    const x = (video.videoWidth - size) / 2, y = (video.videoHeight - size) / 2;
    
    // Draw ROI to small canvas for fast processing
    ctx.drawImage(video, x, y, size, size, 0, 0, 100, 100);

    // Calculate average brightness using luminance formula
    const data = ctx.getImageData(0, 0, 100, 100).data;
    let brightness = 0;
    for (let i = 0; i < data.length; i += 4) {
      brightness += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    brightness /= data.length / 4;

    // Compare to previous brightness
    const diff = prevBrightness.current !== null ? Math.abs(brightness - prevBrightness.current) : 0;
    prevBrightness.current = brightness;
    return diff > BRIGHTNESS_THRESHOLD;
  }, []);

  // ========== MANUAL SCAN: Trigger scan manually via button ==========
  const startManualScan = useCallback(() => {
    setModelEnabled(true);
    if (modelTimeout.current) clearTimeout(modelTimeout.current);
    modelTimeout.current = setTimeout(() => {
      setModelEnabled(false);
      prevBrightness.current = null;
    }, MODEL_DURATION_MS);
  }, []);

  // ========== MOTION LOOP: Runs when model is disabled ==========
  useEffect(() => {
    if (modelEnabled) return; // Don't check motion while scanning
    
    let frameId: number;
    const loop = () => {
      // Throttle motion checks
      if (performance.now() - lastMotionCheck.current >= MOTION_CHECK_INTERVAL_MS) {
        lastMotionCheck.current = performance.now();
        
        if (checkMotion()) {
          // Motion detected! Enable model for MODEL_DURATION_MS
          setModelEnabled(true);
          if (modelTimeout.current) clearTimeout(modelTimeout.current);
          modelTimeout.current = setTimeout(() => {
            setModelEnabled(false);
            prevBrightness.current = null; // Reset baseline
          }, MODEL_DURATION_MS);
        }
      }
      frameId = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(frameId);
  }, [modelEnabled, checkMotion]);

  // ========== DETECTION LOOP: Runs when model is enabled ==========
  const detectObjects = useCallback(async () => {
    const video = videoRef.current, canvas = canvasRef.current, ctx = canvas?.getContext("2d");
    if (!session || !video || !canvas || !ctx || video.readyState !== 4) {
      animationFrameId.current = requestAnimationFrame(detectObjects);
      return;
    }

    // Match canvas to video size
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;

    // Draw mirrored video frame
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();

    // Run inference (throttled)
    const now = performance.now();
    if (!isInferring.current && now - lastInferenceTime.current >= INFERENCE_INTERVAL_MS && tempCanvasRef.current) {
      isInferring.current = true;
      lastInferenceTime.current = now;
      
      try {
        // Preprocess: resize and convert to model input format
        const tempCtx = tempCanvasRef.current.getContext("2d")!;
        tempCtx.drawImage(video, 0, 0, INPUT_SIZE, INPUT_SIZE);
        const imgData = tempCtx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
        
        // Convert RGBA to planar RGB (normalized 0-1)
        const input = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
        for (let i = 0, p = INPUT_SIZE * INPUT_SIZE; i < imgData.length; i += 4) {
          const idx = i / 4;
          input[idx] = imgData[i] / 255;           // R channel
          input[p + idx] = imgData[i + 1] / 255;   // G channel
          input[2 * p + idx] = imgData[i + 2] / 255; // B channel
        }
        
        // Run YOLO
        const tensor = new ort.Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
        const output = (await session.run({ images: tensor })).output0.data as Float32Array;

        // Process output: find detections above confidence threshold
        detectionsRef.current = [];
        for (let i = 0; i < 8400; i++) {
          let maxScore = 0, classId = 0;
          for (let j = 0; j < CLASS_NAMES.length; j++) {
            const score = output[(4 + j) * 8400 + i];
            if (score > maxScore) { maxScore = score; classId = j; }
          }
          if (maxScore > CONFIDENCE_THRESHOLD) {
            const [ox, oy, ow, oh] = [output[i], output[8400 + i], output[16800 + i], output[25200 + i]];
            detectionsRef.current.push({
              className: CLASS_NAMES[classId] || `Class ${classId}`,
              confidence: maxScore,
              bbox: [
                ((ox - ow / 2) * canvas.width) / INPUT_SIZE,
                ((oy - oh / 2) * canvas.height) / INPUT_SIZE,
                (ow * canvas.width) / INPUT_SIZE,
                (oh * canvas.height) / INPUT_SIZE
              ],
            });
          }
        }
      } catch (e) { console.error(e); }
      isInferring.current = false;
    }

    // Draw bounding boxes (mirrored to match video)
    detectionsRef.current.forEach(({ bbox, className, confidence }) => {
      const [bx, by, bw, bh] = [canvas.width - bbox[0] - bbox[2], bbox[1], bbox[2], bbox[3]];
      ctx.strokeStyle = ctx.fillStyle = "#00FF00";
      ctx.lineWidth = 3;
      ctx.strokeRect(bx, by, bw, bh);
      
      const label = `${className} ${(confidence * 100).toFixed(1)}%`;
      ctx.font = "18px Arial";
      ctx.fillRect(bx, by > 25 ? by - 25 : by, ctx.measureText(label).width + 10, 25);
      ctx.fillStyle = "#000";
      ctx.fillText(label, bx + 5, by > 25 ? by - 7 : by + 18);
    });

    animationFrameId.current = requestAnimationFrame(detectObjects);
  }, [session]);

  // ========== START/STOP DETECTION based on modelEnabled ==========
  useEffect(() => {
    if (!session || !videoRef.current) return;
    
    if (!modelEnabled) {
      // Stop detection loop when model disabled
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      animationFrameId.current = null;
      detectionsRef.current = [];
      return;
    }
    
    // Start detection loop when model enabled
    if (videoRef.current.readyState >= 4) detectObjects();
    else videoRef.current.addEventListener("loadeddata", detectObjects, { once: true });
    
    return () => {
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      animationFrameId.current = null;
    };
  }, [session, detectObjects, modelEnabled]);

  // ========== RENDER ==========
  const bannerStyle = { height: "46px", fontFamily: "Arial", fontSize: "20px" };

  return (
    <div className="relative overflow-hidden" style={{ borderRadius: "1rem", border: `4px solid ${modelEnabled ? "#00FF00" : "#000"}` }}>
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
          <p className="text-white text-xl">Loading model...</p>
        </div>
      )}
      
      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-500/90 z-10">
          <p className="text-white px-4">{error}</p>
        </div>
      )}

      {/* Video element - shown when model is disabled (smooth playback) */}
      <video ref={videoRef} autoPlay playsInline className={modelEnabled ? "hidden" : "block"} style={{ width: "100%", transform: "scaleX(-1)" }} />

      {/* ROI Overlay - shown when model is disabled */}
      {!modelEnabled && !isLoading && (
        <div className="absolute inset-0" style={{ transform: "scaleX(-1)" }}>
          {/* Dark overlay with square cutout matching ROI box */}
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden pointer-events-none">
            <div className="bg-transparent" style={{ width: `${ROI_SIZE * 100}%`, aspectRatio: "1", boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)" }} />
          </div>
          
          {/* Instruction banner - z-20 to appear above overlay */}
          <div className="absolute top-0 inset-x-0 flex items-center justify-center bg-black/70 z-20 pointer-events-none" style={{ ...bannerStyle, transform: "scaleX(-1)" }}>
            <p className="text-white font-bold">Place object in the box to scan</p>
          </div>
          
          {/* ROI box - z-10 to appear above overlay */}
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <div className="border-4 border-dashed border-white rounded-lg animate-pulse" style={{ width: `${ROI_SIZE * 100}%`, aspectRatio: "1" }} />
          </div>

          {/* Manual scan button */}
          <div className="absolute bottom-4 inset-x-0 flex flex-col items-center z-20" style={{ transform: "scaleX(-1)" }}>
            <p className="text-white text-sm mb-2">Not Detecting?</p> 
            <button
              onClick={startManualScan}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-400 transition-colors cursor-pointer"
            >
              Click to Scan
            </button>
          </div>
        </div>
      )}

      {/* Canvas - shown when model is enabled (for drawing detections) */}
      <canvas ref={canvasRef} className={modelEnabled ? "block" : "hidden"} style={{ width: "100%" }} />

      {/* Scanning banner - shown when model is enabled */}
      {modelEnabled && (
        <div className="absolute top-0 inset-x-0 flex items-center justify-center" style={{ ...bannerStyle, backgroundColor: "#00FF00" }}>
          <p className="text-black font-bold">Scanning...</p>
        </div>
      )}
    </div>
  );
};

export default MotionDetectionCamera;
