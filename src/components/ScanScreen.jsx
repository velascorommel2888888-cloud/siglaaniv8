import { useState, useEffect, useRef } from 'react';
import * as cocoSsd  from '@tensorflow-models/coco-ssd';
import * as tmImage from '@teachablemachine/image';
import { apiScan } from '../api';
import Topbar   from './shared/Topbar';
import FruitBall from './shared/FruitBall';
import { COCO_FRUIT_LABELS } from '../constants';

export default function ScanScreen({ onScan, onHistory }) {
  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const captureRef  = useRef(null);
  const cocoRef     = useRef(null);
  const mnetRef     = useRef(null);
  const streamRef   = useRef(null);
  const loopRef     = useRef(null);
  const mnetLoopRef = useRef(null);
  const timerRef    = useRef(null);
  const detectStart = useRef(null);
  
  // NEW: Save multiple bounding boxes
  const bestFruitBoxRef = useRef(null);
  const latestCocoPredsRef = useRef([]); 
  const roiCanvasRef = useRef(null);

  const [status,    setStatus]    = useState("loading");
  const [loadMsg,   setLoadMsg]   = useState("Starting camera...");
  const [countdown, setCountdown] = useState(3);
  const [detected,  setDetected]  = useState(null); 

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode:"environment", width:640, height:480 },
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await new Promise(res => (videoRef.current.onloadedmetadata = res));
          videoRef.current.play();
        }
      } catch {
        if (!cancelled) setStatus("error");
        return;
      }

      if (!cancelled) setLoadMsg("Loading detection model (1/2)...");
      const coco = await cocoSsd.load({ base:"lite_mobilenet_v2" });
      if (cancelled) return;
      cocoRef.current = coco;

      if (!cancelled) setLoadMsg("Loading classification model (2/2)...");
      const URL = "/custom_model/";
      const mnet = await tmImage.load(URL + "model.json", URL + "metadata.json");
      if (cancelled) return;
      mnetRef.current = mnet;

      setStatus("scanning");
      runCocoLoop();
      runMobileNetLoop();
    };
    init();

    return () => {
      cancelled = true;
      clearInterval(timerRef.current);
      clearTimeout(loopRef.current);
      clearTimeout(mnetLoopRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  const runCocoLoop = async () => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    const coco   = cocoRef.current;

    if (!video || !canvas || !coco || video.readyState < 2) {
      loopRef.current = setTimeout(runCocoLoop, 200);
      return;
    }

    const preds = await coco.detect(video);
    drawBoxes(preds, canvas, video);
    loopRef.current = setTimeout(runCocoLoop, 150);
  };

  const runMobileNetLoop = async () => {
    const video = videoRef.current;
    const mnet  = mnetRef.current;

    if (!video || !mnet || video.readyState < 2) {
      mnetLoopRef.current = setTimeout(runMobileNetLoop, 400);
      return;
    }

    try {
  const preds = await mnet.predict(video);
  let match = null;
  
  for (const p of preds) {
    if (p.probability > 0.85 && p.className !== "Background") {
      let mappedKey = "generic";
      let modelCondition = "ripe"; // Default condition to "ripe" instead of null
      const classNameStr = p.className.toLowerCase();
      
      if (classNameStr.includes("saging") || classNameStr.includes("banana")) mappedKey = "banana";
      if (classNameStr.includes("apple")) mappedKey = "apple";
      if (classNameStr.includes("orange")) mappedKey = "orange";

      // Directly assign the model's condition
      if (classNameStr.includes("rotten") || classNameStr.includes("bulok")) {
        modelCondition = "rotten";
      } else if (classNameStr.includes("fresh") || classNameStr.includes("ripe")) {
        modelCondition = "ripe"; // CHANGED: Set to "ripe" instead of null!
      }

      const rawFruit = p.className.split("_")[0];
      const fruitDisplayName = rawFruit.charAt(0).toUpperCase() + rawFruit.slice(1);

      match = { 
        fruit: fruitDisplayName,
        rawLabel: p.className,
        scientific: "SIGLA ANI AI", 
        hsvKey: mappedKey,
        explicitCondition: modelCondition,
        confidence: Math.round(p.probability * 100) 
      };

      // Set window globals so the condition is forwarded to the backend
      window.__siglaani_fruit_name__ = fruitDisplayName;
      window.__siglaani_hsv_key__ = mappedKey;
      window.__siglaani_class_condition__ = modelCondition;
      window.__siglaani_model_confidence__ = Math.round(p.probability * 100);

      break; 
    }
  }

      if (match) {
        setDetected(match); 
        window.__siglaani_detected_fruit__   = match.rawLabel;
        window.__siglaani_hsv_key__          = match.hsvKey;
        window.__siglaani_fruit_name__       = match.fruit;
        window.__siglaani_scientific__       = match.scientific;
        window.__siglaani_class_condition__  = match.explicitCondition; 

        if (!detectStart.current) {
          detectStart.current = Date.now();
          let secs = 3;
          setCountdown(secs);
          timerRef.current = setInterval(() => {
            secs -= 1;
            setCountdown(secs);
            if (secs <= 0) {
              clearInterval(timerRef.current);
              captureAndProceed(); 
            }
          }, 1000);
        }
      } else {
        if (detectStart.current) {
          detectStart.current = null;
          clearInterval(timerRef.current);
          setCountdown(3);
          setDetected(null);
        }
      }
    } catch (e) {
      console.warn("MobileNet error:", e);
    }
    mnetLoopRef.current = setTimeout(runMobileNetLoop, 800);
  };

  const drawBoxes = (preds, canvas, video) => {
    const rect    = video.getBoundingClientRect();
    canvas.width  = rect.width  || video.videoWidth;
    canvas.height = rect.height || video.videoHeight;
    const ctx     = canvas.getContext("2d");
    const scaleX  = canvas.width  / video.videoWidth;
    const scaleY  = canvas.height / video.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const fruitPreds = preds
      .filter(pred => COCO_FRUIT_LABELS.includes(pred.class.toLowerCase()) && pred.score > 0.35)
      .sort((a, b) => b.score - a.score);

    // SAVE MULTIPLE FRUITS FOR CAPTURE
    latestCocoPredsRef.current = fruitPreds;
    bestFruitBoxRef.current = fruitPreds[0]?.bbox ?? null;

    fruitPreds.forEach(pred => {
      const [x, y, w, h] = pred.bbox;
      const sx = x * scaleX, sy = y * scaleY;
      const sw = w * scaleX, sh = h * scaleY;
      const conf = Math.round(pred.score * 100);

      ctx.strokeStyle = "#7ee84a";
      ctx.lineWidth   = 2;
      ctx.strokeRect(sx, sy, sw, sh);

      const cLen = 14;
      ctx.lineWidth   = 3.5;
      [[sx,sy,1,1],[sx+sw,sy,-1,1],[sx,sy+sh,1,-1],[sx+sw,sy+sh,-1,-1]].forEach(([cx,cy,dx,dy]) => {
        ctx.beginPath();
        ctx.moveTo(cx + dx * cLen, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + dy * cLen);
        ctx.stroke();
      });

      const label = `${pred.class.toUpperCase()}  ${conf}%`;
      ctx.font      = "bold 12px Nunito, sans-serif";
      const tw      = ctx.measureText(label).width;
      ctx.fillStyle = "#7ee84a";
      ctx.fillRect(sx, sy - 22, tw + 14, 20);
      ctx.fillStyle = "#0b1f0d";
      ctx.fillText(label, sx + 7, sy - 7);
    });
  };

  const captureAndProceed = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    // 1. Capture the snapshot frame
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const base64Image = canvas.toDataURL("image/jpeg");

    window.__siglaani_captured_image__ = base64Image;
    window.__siglaani_bbox__ = bestFruitBoxRef.current || null;

    // 2. Lock in Teachable Machine values (Prevent COCO-SSD override)
    if (detected) {
      window.__siglaani_fruit_name__       = detected.fruit;
      window.__siglaani_hsv_key__          = detected.hsvKey;
      window.__siglaani_class_condition__  = detected.explicitCondition;
      window.__siglaani_model_confidence__ = detected.confidence;
    }

    // 3. Trigger transition to Processing Screen
    if (typeof onScan === "function") {
      onScan(); 
    }
  };

  return (
    <div className="screen scan-screen">
      <Topbar right={status === "loading" ? loadMsg : "Live Scanning"} onHistory={onHistory} showHistoryBtn />
      <div className="scan-wrap">
        <div className="scan-viewfinder">
          <div className="vf-corner tl"/><div className="vf-corner tr"/>
          <div className="vf-corner bl"/><div className="vf-corner br"/>

          {status === "error" ? (
            <div className="cam-fallback">
              <FruitBall size={180}/>
              <div className="cam-err-badge">No camera detected</div>
            </div>
          ) : (
            <>
              <video ref={videoRef} autoPlay playsInline muted style={{ width:"100%", height:"100%", objectFit:"cover", borderRadius:14, display:"block" }}/>
              <canvas ref={canvasRef} style={{ position:"absolute", inset:0, width:"100%", height:"100%", borderRadius:14, pointerEvents:"none" }}/>
            </>
          )}

          <canvas ref={captureRef} style={{ display:"none" }}/>

          {status === "loading" && (
            <div className="scan-loading-overlay">
              <div className="scan-loading-spinner"/><span>{loadMsg}</span>
            </div>
          )}

          {detected && status === "scanning" && (
            <div className="scan-countdown-wrap">
              <svg width="70" height="70" viewBox="0 0 70 70">
                <circle cx="35" cy="35" r="30" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.08)" strokeWidth="4"/>
                <circle cx="35" cy="35" r="30" fill="none" stroke="#7ee84a" strokeWidth="4" strokeDasharray={`${((3 - countdown) / 3) * 188} 188`} strokeLinecap="round" transform="rotate(-90 35 35)" style={{ transition:"stroke-dasharray 0.9s linear" }}/>
                <text x="35" y="42" textAnchor="middle" fill="#fff" fontSize="22" fontWeight="800" fontFamily="Nunito, sans-serif">{countdown}</text>
              </svg>
            </div>
          )}
        </div>

        <div className="scan-panel">
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            <div className="scan-info-title">
              {detected ? "Scanning Multiple Fruits..." : "Handa na ba?"}
            </div>
            <div className="scan-info-body">
              {detected
                ? "Panatilihin ang mga prutas sa loob ng frame. Kukunin ng system ang lahat ng nasa screen."
                : "Iposisyon ang mga prutas sa harap ng camera."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}