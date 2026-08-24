import { useState, useCallback, useEffect, useRef } from "react";
import "./App.css";

import SplashScreen       from "./components/SplashScreen";
import InstructionsScreen from "./components/InstructionsScreen";
import ScanScreen         from "./components/ScanScreen";
import ProcessingScreen   from "./components/ProcessingScreen";
import ResultScreen       from "./components/ResultScreen";
import HistoryScreen      from "./components/HistoryScreen";
import DashboardScreen    from "./components/DashboardScreen";

import { RECOMMENDATIONS } from "./constants";

let scanCounter = 0;

// REQ-4: Auto-return to splash after this many ms of inactivity
const INACTIVITY_TIMEOUT_MS = 60_000;

const CONDITION_LABELS = {
  ripe:     "Hinog (Ripe)",
  overripe: "Sobrang Hinog (Overripe)",
  unripe:   "Hindi Pa Hinog (Unripe)",
  rotten:   "Bulok (Rotten)",
};

function scoreFromFreshness(condition) {
  return condition === "ripe" ? 5 : condition === "rotten" ? 1 : 2;
}

function applyFruitIdentity(result) {
  const fruitName      = window.__siglaani_fruit_name__ || result.fruit || "Apple";
  const scientific     = window.__siglaani_scientific__ || "SIGLA ANI AI";
  const modelCondition = window.__siglaani_class_condition__ || result.condition || "ripe";
  const capturedImage  = window.__siglaani_captured_image__ || result.image || null;

  result.fruit          = fruitName;
  result.scientific     = scientific;
  result.condition      = modelCondition;
  result.conditionLabel = CONDITION_LABELS[modelCondition] || "Hinog (Ripe)";
  result.rating         = scoreFromFreshness(modelCondition);
  result.image          = capturedImage;

  const baseReco = RECOMMENDATIONS[modelCondition] || "";
  const prefix = modelCondition === "ripe"
    ? `${fruitName} looks fresh. `
    : `${fruitName} looks not fresh. `;
  result.recommendation = `${prefix}${baseReco}`;

  return result;
}

/** REQ-4: Wipe everything that could leak between sessions. */
function clearSessionData() {
  delete window.__siglaani_captured_image__;
  delete window.__siglaani_capture__;
  delete window.__siglaani_fruit_name__;
  delete window.__siglaani_scientific__;
  delete window.__siglaani_hsv_key__;
  delete window.__siglaani_class_condition__;
  delete window.__siglaani_bbox__;
  delete window.__siglaani_fruits_payload__;
}

export default function App() {
  const [screen,     setScreen]     = useState("splash");
  const [result,     setResult]     = useState(null);
  const [scanId,     setScanId]     = useState(0);
  const [prevScreen, setPrevScreen] = useState("splash");

  const inactivityRef = useRef(null);

  const go = useCallback((s) => setScreen(s), []);

  const goHistory = useCallback(() => {
    setPrevScreen(screen);
    setScreen("history");
  }, [screen]);

  const goDashboard = useCallback(() => {
    setPrevScreen(screen);
    setScreen("dashboard");
  }, [screen]);

  // REQ-4: timeout handler
  const handleInactivityTimeout = useCallback(() => {
    console.log("[SiglaAni] Inactivity timeout — clearing session");
    clearSessionData();
    setResult(null);
    setScanId(0);
    setPrevScreen("splash");
    setScreen("splash");
  }, []);

  useEffect(() => {
    if (screen === "splash") {
      if (inactivityRef.current) {
        clearTimeout(inactivityRef.current);
        inactivityRef.current = null;
      }
      return;
    }

    const reset = () => {
      if (inactivityRef.current) clearTimeout(inactivityRef.current);
      inactivityRef.current = setTimeout(handleInactivityTimeout, INACTIVITY_TIMEOUT_MS);
    };

    const events = ["mousedown", "mousemove", "keydown", "touchstart", "click", "scroll"];
    events.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();

    return () => {
      events.forEach(e => window.removeEventListener(e, reset));
      if (inactivityRef.current) {
        clearTimeout(inactivityRef.current);
        inactivityRef.current = null;
      }
    };
  }, [screen, handleInactivityTimeout]);

  const handleProcessingComplete = useCallback((processedResults) => {
    scanCounter++;

    // Accept batch results directly from ProcessingScreen
    if (processedResults && (Array.isArray(processedResults) ? processedResults.length > 0 : processedResults.results)) {
      const finalArray = Array.isArray(processedResults) 
        ? processedResults 
        : (processedResults.results || [processedResults]);

      setResult(finalArray);
      setScanId(finalArray[0]?.transaction_id || finalArray[0]?.id || scanCounter);
      go("result");
      return;
    }

    // Offline / single fruit fallback
    const fruitName      = window.__siglaani_fruit_name__ || "Apple";
    const modelCondition = window.__siglaani_class_condition__ || "ripe";
    const imagePayload   = window.__siglaani_captured_image__ || null;

    const fallbackResult = applyFruitIdentity({
      fruit:          fruitName,
      scientific:     "SIGLA ANI AI",
      condition:      modelCondition,
      confidence:     85,
      rating:         scoreFromFreshness(modelCondition),
      id:             scanCounter,
      image:          imagePayload,
      xai: { available: false, notice: "Offline mode" }
    });

    setResult([fallbackResult]);
    setScanId(scanCounter);
    go("result");
  }, [go]);

  const handleHome = useCallback(() => {
    clearSessionData();
    setResult(null);
    setScanId(0);
    go("splash");
  }, [go]);

  return (
    <div className="app-root">
      <div className="app-shell">
        {screen === "splash"     && <SplashScreen onStart={() => go("instr1")} onDashboard={goDashboard}/>}
        {screen === "instr1"     && <InstructionsScreen page={1} onNext={() => go("instr2")} onBack={() => go("splash")}/>}
        {screen === "instr2"     && <InstructionsScreen page={2} onNext={() => go("scan")}   onBack={() => go("instr1")}/>}
        {screen === "scan"       && <ScanScreen onScan={() => go("processing")} onHistory={goHistory}/>}
        {screen === "processing" && <ProcessingScreen onComplete={handleProcessingComplete}/>}
        {screen === "result"     && <ResultScreen result={result} scanId={scanId} onScanAgain={() => go("scan")} onHome={handleHome} onHistory={goHistory} onDashboard={goDashboard}/>}
        {screen === "history"    && <HistoryScreen onBack={() => go(prevScreen || "splash")} onScanAgain={() => go("scan")}/>}
        {screen === "dashboard"  && <DashboardScreen onBack={() => go(prevScreen || "splash")}/>}
      </div>
    </div>
  );
}