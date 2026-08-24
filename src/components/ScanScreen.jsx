import { useState, useEffect, useRef } from 'react';
import * as cocoSsd  from '@tensorflow-models/coco-ssd';
import * as tmImage from '@teachablemachine/image';
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
  
  const latestCocoPredsRef = useRef([]); 

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

    try {
      const preds = await coco.detect(video);
      drawBoxes(preds, canvas, video);
    } catch (e) {
      console.warn(e);
    }
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
        if (p.probability > 0.65 && p.className !== "Background") {
          let modelCondition = "ripe";
          const classNameStr = p.className.toLowerCase();
          
          if (classNameStr.includes("rotten") || classNameStr.includes("bulok")) {
            modelCondition = "rotten";
          } else if (classNameStr.includes("fresh") || classNameStr.includes("ripe")) {
            modelCondition = "ripe";
          }

          let detectedFruitName = "Apple";
          if (classNameStr.includes("banana") || classNameStr.includes("saging")) detectedFruitName = "Saging";
          else if (classNameStr.includes("orange")) detectedFruitName = "Orange";
          else if (classNameStr.includes("apple")) detectedFruitName = "Apple";

          match = { 
            fruit: detectedFruitName,
            rawLabel: p.className,
            explicitCondition: modelCondition,
            confidence: Math.round(p.probability * 100) 
          };
          break;
        }
      }

      if (match) {
        setDetected(match); 
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
      console.warn("MobileNet loop error:", e);
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

    const fruitPreds = preds.filter(pred => {
      const name = pred.class.toLowerCase();
      return (
        COCO_FRUIT_LABELS.includes(name) ||
        ['apple', 'banana', 'orange', 'fruit'].includes(name)
      ) && pred.score > 0.20;
    });

    latestCocoPredsRef.current = fruitPreds;

    fruitPreds.forEach(pred => {
      const [x, y, w, h] = pred.bbox;
      const sx = x * scaleX, sy = y * scaleY;
      const sw = w * scaleX, sh = h * scaleY;
      const conf = Math.round(pred.score * 100);

      ctx.strokeStyle = "#7ee84a";
      ctx.lineWidth   = 2;
      ctx.strokeRect(sx, sy, sw, sh);

      const label = `${pred.class.toUpperCase()} ${conf}%`;
      ctx.font      = "bold 12px Nunito, sans-serif";
      const tw      = ctx.measureText(label).width;
      ctx.fillStyle = "#7ee84a";
      ctx.fillRect(sx, sy - 22, tw + 14, 20);
      ctx.fillStyle = "#0b1f0d";
      ctx.fillText(label, sx + 7, sy - 7);
    });
  };

  const classifyCrop = async (cropCanvas) => {
    const mnet = mnetRef.current;
    if (!mnet) return { fruit: "Unknown", condition: "ripe", confidence: 85 };

    try {
      const preds = await mnet.predict(cropCanvas);
      const top = preds.filter(p => p.className !== "Background").sort((a,b) => b.probability - a.probability)[0];
      if (top && top.probability > 0.40) {
        const cName = top.className.toLowerCase();
        let fruit = "Apple";
        if (cName.includes("banana") || cName.includes("saging")) fruit = "Saging";
        else if (cName.includes("orange")) fruit = "Orange";
        else if (cName.includes("apple")) fruit = "Apple";

        let condition = (cName.includes("rotten") || cName.includes("bulok")) ? "rotten" : "ripe";
        return { fruit, condition, confidence: Math.round(top.probability * 100) };
      }
    } catch (err) {
      console.warn("Classification error:", err);
    }
    return { fruit: "Unknown", condition: "ripe", confidence: 80 };
  };

  const captureAndProceed = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // 1. Snapshot full frame
    const canvas = document.createElement("canvas");
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, vw, vh);
    const base64Image = canvas.toDataURL("image/jpeg");

    let fruitsPayload = [];
    const detectedBoxes = latestCocoPredsRef.current || [];

    // CASE A: COCO detected 2 or more distinct fruits
    if (detectedBoxes.length >= 2) {
      for (const p of detectedBoxes) {
        const [bx, by, bw, bh] = p.bbox;
        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = Math.max(10, bw);
        cropCanvas.height = Math.max(10, bh);
        const cropCtx = cropCanvas.getContext("2d");
        cropCtx.drawImage(video, bx, by, bw, bh, 0, 0, bw, bh);

        const res = await classifyCrop(cropCanvas);
        fruitsPayload.push({
          detected_fruit: p.class.charAt(0).toUpperCase() + p.class.slice(1) || res.fruit,
          bbox: p.bbox,
          model_condition: res.condition,
          model_confidence: Math.max(Math.round(p.score * 100), res.confidence)
        });
      }
    } 
    // CASE B: 2 items are present on Left & Right sides of the frame
    else {
      // Crop Left Zone (e.g. Apple)
      const leftCanvas = document.createElement("canvas");
      leftCanvas.width = vw / 2;
      leftCanvas.height = vh;
      leftCanvas.getContext("2d").drawImage(video, 0, 0, vw / 2, vh, 0, 0, vw / 2, vh);
      const leftRes = await classifyCrop(leftCanvas);

      // Crop Right Zone (e.g. Banana)
      const rightCanvas = document.createElement("canvas");
      rightCanvas.width = vw / 2;
      rightCanvas.height = vh;
      rightCanvas.getContext("2d").drawImage(video, vw / 2, 0, vw / 2, vh, 0, 0, vw / 2, vh);
      const rightRes = await classifyCrop(rightCanvas);

      fruitsPayload = [
        {
          detected_fruit: leftRes.fruit !== "Unknown" ? leftRes.fruit : "Apple",
          bbox: [0, 0, vw / 2, vh],
          model_condition: leftRes.condition,
          model_confidence: leftRes.confidence
        },
        {
          detected_fruit: rightRes.fruit !== "Unknown" ? rightRes.fruit : "Saging",
          bbox: [vw / 2, 0, vw / 2, vh],
          model_condition: rightRes.condition,
          model_confidence: rightRes.confidence
        }
      ];
    }

    console.log("🔥 [ScanScreen] FORCED MULTI-PAYLOAD:", fruitsPayload);

    window.__siglaani_captured_image__ = base64Image;
    window.__siglaani_fruits_payload__ = fruitsPayload;

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
                ? "Panatilihin ang mga prutas sa screen. Sinusuri ang lahat ng nakapaloob."
                : "Iposisyon ang mga prutas sa kaliwa at kanan ng camera."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}