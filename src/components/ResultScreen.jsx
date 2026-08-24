import { useState } from 'react';
import LeafSVG from './shared/LeafSVG';
import { FaUndo, FaHome, FaChevronLeft, FaChevronRight, FaQrcode, FaList } from 'react-icons/fa';

const LIKERT = [
  { stars: 1, label: "Hindi Nakakain",  color: "#ef5350" },
  { stars: 2, label: "Medyo Luma",      color: "#f97316" },
  { stars: 3, label: "Katamtaman",      color: "#f9a825" },
  { stars: 4, label: "Sariwa",          color: "#66bb6a" },
  { stars: 5, label: "Napakasariwa",    color: "#5cb83a" },
];

function StarRating({ rating = 3 }) {
  const info = LIKERT[Math.min(Math.max(rating, 1), 5) - 1];
  return (
    <div className="star-rating-wrap">
      <div className="star-row">
        {[1, 2, 3, 4, 5].map(n => (
          <svg key={n} width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2l2.9 6.1L22 9.3l-5 4.9 1.2 6.8L12 17.8l-6.2 3.2L7 14.2 2 9.3l6.5-.5L12 2z"
              fill={n <= rating ? info.color : "rgba(0,0,0,.08)"}
            />
          </svg>
        ))}
      </div>
      <div className="star-label" style={{ color: info.color }}>{info.label}</div>
    </div>
  );
}

export default function ResultScreen({ result, scanId, onScanAgain, onDashboard, onHome }) {
  const [viewMode, setViewMode] = useState("qr");
  const [currentIndex, setCurrentIndex] = useState(0);

  // Extract array whether result is a direct array or single object
  const results = Array.isArray(result) 
    ? result 
    : (result?.results ? result.results : [result]);

  const res = results[currentIndex];
  if (!res) return null;

  // Single QR code targeting the batch transaction_id or scanId
  const qrTarget = String(res.transaction_id || scanId || res.id || 1);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrTarget)}`;

  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Resolve individual cropped image URI
  const imageSource = res.image_url 
    ? (res.image_url.startsWith('http') ? res.image_url : `http://127.0.0.1:5001${res.image_url}`)
    : (res.image ? (res.image.startsWith("data:") ? res.image : `data:image/jpeg;base64,${res.image}`) : null);

  return (
    <div className="screen result-screen">
      {/* Top Header */}
      <div className="result-header">
        <div className="header-logo">
          <LeafSVG />
          <div className="header-logo-text">SIGLA ANI</div>
        </div>
        <div className={`result-badge badge-${res.condition || 'ripe'}`}>
          {res.conditionLabel || res.status || res.condition}
        </div>
      </div>

      <div className="result-body" style={{ flexDirection: "column", overflowY: "auto", padding: "16px" }}>
        
        {/* VIEW MODE 1: DIGITAL RECEIPT QR */}
        {viewMode === "qr" ? (
          <div className="result-hero" style={{ textAlign: "center", padding: "24px", maxWidth: "450px", margin: "auto", width: "100%" }}>
            <h2 style={{ fontSize: "1.5rem", fontWeight: "800", color: "#0b1f0d", marginBottom: "0.5rem" }}>
              Scan QR for Receipt & History
            </h2>
            <p style={{ color: "#666", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
              Mayroong <strong>{results.length}</strong> na-scan na prutas sa batch na ito.
            </p>
            
            <div style={{ background: "#fff", padding: "12px", display: "inline-block", borderRadius: "16px", boxShadow: "0 6px 20px rgba(0,0,0,0.06)", marginBottom: "1.5rem" }}>
              <img src={qrUrl} alt="Transaction QR" style={{ width: "200px", height: "200px", display: "block" }} />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%" }}>
              <button 
                className="scan-again-btn" 
                onClick={() => setViewMode("details")} 
                style={{ width: "100%", background: "#0b1f0d", color: "#7ee84a", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
              >
                <FaList /> Inspect Slides ({results.length} Fruits)
              </button>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <button className="history-btn" onClick={onScanAgain} style={{ justifyContent: "center", display: "flex", gap: "6px" }}>
                  <FaUndo /> Scan Again
                </button>
                <button className="history-btn" onClick={onHome} style={{ justifyContent: "center", display: "flex", gap: "6px" }}>
                  <FaHome /> Home
                </button>
              </div>
            </div>
          </div>
        ) : (

        /* VIEW MODE 2: MULTI-SLIDE DETAILS */
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "16px" }}>
            
            {/* Carousel Navigation Toolbar */}
            {results.length > 1 && (
              <div className="result-hero" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", marginBottom: "0" }}>
                <button 
                  onClick={() => setCurrentIndex(prev => Math.max(0, prev - 1))}
                  disabled={currentIndex === 0}
                  style={{ background: "none", border: "none", display: "flex", alignItems: "center", gap: "4px", fontSize: "14px", fontWeight: "bold", cursor: currentIndex === 0 ? "not-allowed" : "pointer", color: currentIndex === 0 ? "#bbb" : "#0b1f0d" }}
                >
                  <FaChevronLeft /> Prev
                </button>

                <span style={{ fontWeight: "800", color: "#1a6630", fontSize: "0.95rem" }}>
                  Fruit {currentIndex + 1} of {results.length}
                </span>

                <button 
                  onClick={() => setCurrentIndex(prev => Math.min(results.length - 1, prev + 1))}
                  disabled={currentIndex === results.length - 1}
                  style={{ background: "none", border: "none", display: "flex", alignItems: "center", gap: "4px", fontSize: "14px", fontWeight: "bold", cursor: currentIndex === results.length - 1 ? "not-allowed" : "pointer", color: currentIndex === results.length - 1 ? "#bbb" : "#0b1f0d" }}
                >
                  Next <FaChevronRight />
                </button>
              </div>
            )}

            {/* Individual Cropped Fruit Card */}
            <div className="result-hero">
              {imageSource && (
                <div style={{ width: "100%", height: "220px", borderRadius: "12px", overflow: "hidden", marginBottom: "16px", background: "#0b1f0d" }}>
                  <img 
                    src={imageSource} 
                    alt={res.fruit || "Fruit Crop"} 
                    style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} 
                  />
                </div>
              )}

              <div className="res-fruit-profile">
                <div className="res-title-row">
                  <h1 className="res-name">{res.fruit || res.fruit_type || "Unknown"}</h1>
                  <span className="res-sci">{res.scientific || "SIGLA ANI AI"}</span>
                </div>
                <StarRating rating={res.rating ?? 3} />
              </div>

              <div className="res-rec-box">
                <div className="res-rec-label">Storage Recommendation:</div>
                <div className="res-rec-text">"{res.recommendation}"</div>
              </div>
            </div>

            {/* Metadata Grid */}
            <div className="res-meta-grid">
              <div className="res-meta-cell">
                <div className="res-meta-label">Confidence</div>
                <div className="res-meta-val">{res.confidence ?? 90}%</div>
              </div>
              <div className="res-meta-cell">
                <div className="res-meta-label">Status</div>
                <div className="res-meta-val" style={{ color: '#4ade80' }}>
                  {res.conditionLabel || res.status || "Ripe"}
                </div>
              </div>
              <div className="res-meta-cell">
                <div className="res-meta-label">Oras ng Scan</div>
                <div className="res-meta-val">{now}</div>
              </div>
            </div>

            {/* XAI Heatmap (if available) */}
            {res.xai?.available && (
              <div className="result-hero" style={{ padding: "16px" }}>
                <div className="res-rec-label" style={{ marginBottom: "10px" }}>Explainable AI (XAI) Saliency Map:</div>
                <div style={{ borderRadius: "8px", overflow: "hidden" }}>
                  <img src={`data:image/jpeg;base64,${res.xai.overlay}`} alt="XAI" style={{ width: "100%", display: "block" }} />
                </div>
                <p style={{ fontSize: "12px", color: "#555", marginTop: "8px", fontStyle: "italic" }}>
                  {res.xai.explanation}
                </p>
              </div>
            )}

            {/* Footer Navigation */}
            <div className="result-footer" style={{ marginTop: "8px" }}>
              <button className="scan-again-btn" onClick={onScanAgain}>+ I-scan Muli</button>
              <button onClick={onDashboard} className="history-btn" style={{ fontWeight: "bold" }}>
                📊 Dashboard
              </button>
              <button className="history-btn" onClick={() => setViewMode("qr")} style={{ display: "flex", gap: "6px", alignItems: "center", justifyContent: "center" }}>
                <FaQrcode /> Show QR
              </button>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}