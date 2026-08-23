import { useState, useEffect } from 'react';
import logo from '../logo.png';
import Topbar from './shared/Topbar';
// 1. I-import ang apiScan function mula sa iyong api.js file
import { apiScan } from '../api'; 

const PROC_STEPS = [
  "Kinukuha ang larawan",
  "Sinusuri ang kulay at texture",
  "Nagpapatakbo ng ML model",
  "Naghahanda ng resulta...",
];
const MILESTONES = [25, 55, 80, 100];

export default function ProcessingScreen({ onComplete }) {
  const [progress, setProgress] = useState(0);
  const [stepIdx,  setStepIdx]  = useState(0);

  useEffect(() => {
    let resultsArray = [];
    let apiFinished = false;

    // 2. Gawa ng async function para tawagin ang API ng sunod-sunod para sa bawat prutas
    const processFruitsData = async () => {
      try {
        const image = window.__siglaani_captured_image__;
        const fruits = window.__siglaani_multiple_fruits__ || [];
        
        // Limitahan sa 4 na prutas max para hindi mag-timeout ang server
        const scanLimit = Math.min(fruits.length, 4); 

        for (let i = 0; i < scanLimit; i++) {
          const f = fruits[i];
          const payload = {
            image: image,
            detected_fruit: f.hsv_key,
            bbox: f.bbox
          };
          
          // Tawagin ang backend
          const res = await apiScan(payload);
          if (res && res.data) {
            resultsArray.push(res.data);
          }
        }
      } catch (err) {
        console.error("Error processing multiple fruits:", err);
      } finally {
        // Sabihin sa loading animation na tapos na ang background network requests
        apiFinished = true; 
      }
    };

    // Patakbuhin agad ang API processing pagkapasok sa screen
    processFruitsData();

    // 3. Loading Animation Loop na may kasamang Network Sync Logic
    let p = 0, si = 0;
    const iv = setInterval(() => {
      // Kung umabot na sa 95% pero naglo-load pa sa background ang Pi, i-hold muna ang animation
      if (p >= 95 && !apiFinished) {
        p = 95; 
      } else {
        p += Math.random() * 4 + 1;
      }

      if (p > 100) p = 100;
      setProgress(Math.round(p));

      if (si < MILESTONES.length && p >= MILESTONES[si]) { 
        si++; 
        setStepIdx(si); 
      }

      // Kapag 100% na at tapos na ang lahat ng API calls, lumipat sa ResultScreen
      if (p >= 100 && apiFinished) { 
        clearInterval(iv); 
        // Ipapasa ang buong resultsArray sa onComplete prop papuntang ResultScreen
        setTimeout(() => onComplete(resultsArray), 700); 
      }
    }, 60);

    return () => clearInterval(iv);
  }, [onComplete]);

  return (
    <div className="screen processing-screen">
      <Topbar right="Nagpo-proseso..."/>
      <div className="proc-wrap">
        <div className="proc-scanner">
          <div className="proc-scanline"/>
          <img src={logo} alt="logo" width="90" height="90"
            style={{ objectFit:"contain", opacity:0.7 }}/>
        </div>
        <div className="proc-info">
          <div className="proc-label">Sinusuri...</div>
          <div className="proc-sub">{PROC_STEPS[Math.min(stepIdx, 3)]}</div>
          <div className="proc-bar-wrap">
            <div className="proc-bar-fill" style={{ width:`${progress}%` }}/>
          </div>
          <div className="proc-pct">{progress}%</div>
          <div className="proc-steps">
            {PROC_STEPS.map((s, i) => (
              <div key={i} className={`proc-step-item ${i < stepIdx ? "done" : i === stepIdx ? "active" : ""}`}>
                <div className="proc-step-dot"/>{s}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}