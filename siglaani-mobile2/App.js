import React, { useState, useEffect } from 'react';
import { 
  View, 
  Text,
  Image, 
  TouchableOpacity, 
  SafeAreaView, 
  ActivityIndicator, 
  Alert, 
  FlatList, 
  StatusBar 
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as SQLite from 'expo-sqlite';
import { BASE_URL } from './config';
import { styles, COLORS } from './styles';

// Helper for clean Title Casing
const formatFruitName = (name) => {
  if (!name || typeof name !== 'string') return "Unknown";
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
};

export default function App() {
  const [tab, setTab] = useState('scan');
  const [originTab, setOriginTab] = useState('scan');
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [db, setDb] = useState(null);

  useEffect(() => {
    async function setupDb() {
      try {
        const database = await SQLite.openDatabaseAsync('siglaani_mobile.db');
        
        // 1. Create table if it doesn't exist
        await database.execAsync(`
          CREATE TABLE IF NOT EXISTS local_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_id INTEGER,
            fruit_type TEXT,
            scientific TEXT,
            status TEXT,
            confidence REAL,
            rating INTEGER,
            recommendation TEXT,
            image_url TEXT,
            timestamp TEXT
          );
        `);

        // 2. Migration: Add column if existing DB was created without it
        try {
          await database.execAsync(`ALTER TABLE local_history ADD COLUMN image_url TEXT;`);
        } catch (colErr) {
          // Column already exists, safe to ignore
        }

        setDb(database);
      } catch (e) {
        console.warn("DB init error:", e);
      }
    }
    setupDb();
  }, []);

  const loadHistory = async () => {
    if (!db) return;
    try {
      const rows = await db.getAllAsync('SELECT * FROM local_history ORDER BY id DESC LIMIT 50;');
      setHistory(rows);
    } catch (e) {
      console.warn("Error loading history:", e);
    }
  };

  useEffect(() => {
    if (tab === 'history' && db) {
      loadHistory();
    }
  }, [tab, db]);

  const deleteHistoryItem = (id, fruitName) => {
    Alert.alert(
      "Burahin ang Scan?",
      `Nais mo bang burahin ang scan record para sa ${fruitName}?`,
      [
        { text: "Kanselahin", style: "cancel" },
        { 
          text: "Burahin", 
          style: "destructive",
          onPress: async () => {
            if (!db) return;
            try {
              await db.runAsync('DELETE FROM local_history WHERE id = ?;', [id]);
              setHistory(prev => prev.filter(item => item.id !== id));
            } catch (err) {
              console.warn("Failed to delete record:", err);
            }
          }
        }
      ]
    );
  };

  const handleBarcodeScanned = async ({ data }) => {
    if (scanned || loading) return;
    setScanned(true);
    setLoading(true);

    try {
      const trimmed = data.trim();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      let endpoint = '';
      let isReceipt = false;

      // Check if QR code is a Batch Transaction (TXN_...) or single scan ID
      if (trimmed.startsWith('TXN_') || trimmed.includes('TXN_')) {
        const txnId = trimmed.includes('TXN_') ? `TXN_${trimmed.split('TXN_')[1]}` : trimmed;
        endpoint = `${BASE_URL}/api/receipt/${txnId}`;
        isReceipt = true;
      } else {
        const parts = trimmed.split('/');
        const rawId = parts[parts.length - 1];
        const scanId = parseInt(rawId.replace(/\D/g, ''), 10) || 1;
        endpoint = `${BASE_URL}/api/scan/${scanId}`;
      }

      const res = await fetch(endpoint, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`Record ${trimmed} not found on server.`);
      const responseData = await res.json();

      let resultData = responseData;
      if (isReceipt && responseData.items && responseData.items.length > 0) {
        resultData = {
          ...responseData.items[0],
          transaction_id: responseData.transaction_id,
          total_items: responseData.total_items
        };
      }

      const formattedFruit = formatFruitName(resultData.fruit_type || resultData.fruit);
      resultData.fruit_type = formattedFruit;

      setScanResult(resultData);
      setOriginTab('scan');

      const saveScanId     = Number(resultData.scan_id || resultData.id || 1);
      const saveFruit      = formattedFruit;
      const saveScientific = String(resultData.scientific || "SIGLA ANI AI");
      const saveStatus     = String(resultData.status || resultData.conditionLabel || resultData.condition || "Hinog");
      const saveConf       = Number(resultData.confidence || 90);
      const saveRating     = Number(resultData.rating || 4);
      const saveReco       = String(resultData.recommendation || "");
      const saveImg        = String(resultData.image_url || "");
      const saveTime       = String(resultData.timestamp || new Date().toLocaleString());

      if (db) {
        try {
          await db.runAsync(
            `INSERT INTO local_history (scan_id, fruit_type, scientific, status, confidence, rating, recommendation, image_url, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [saveScanId, saveFruit, saveScientific, saveStatus, saveConf, saveRating, saveReco, saveImg, saveTime]
          );
        } catch (dbErr) {
          console.warn("Local SQLite insert skipped:", dbErr);
        }
      }

      setTab('result');
    } catch (err) {
      const msg = err.name === 'AbortError' 
        ? `Could not connect to ${BASE_URL}. Check your network.`
        : err.message;

      Alert.alert('Scan Failed', msg, [
        { text: 'Try Again', onPress: () => setScanned(false) }
      ]);
    } finally {
      setLoading(false);
    }
  };

  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.container, { justifyContent: 'center', alignItems: 'center', padding: 20 }]}>
        <Text style={{ color: COLORS.text, fontSize: 16, textAlign: 'center', marginBottom: 20 }}>
          Sigla Ani needs camera access to scan kiosk QR codes.
        </Text>
        <TouchableOpacity style={[styles.btn, { width: '80%' }]} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant Permission</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
      
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>SIGLA ANI COMPANION</Text>
      </View>

      {/* Tabs */}
      <View style={styles.navTabs}>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'scan' && styles.activeTabBtn]}
          onPress={() => { setScanned(false); setTab('scan'); }}
        >
          <Text style={[styles.tabText, tab === 'scan' && styles.activeTabText]}>Scan QR</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'history' && styles.activeTabBtn]}
          onPress={() => { loadHistory(); setTab('history'); }}
        >
          <Text style={[styles.tabText, tab === 'history' && styles.activeTabText]}>History</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      <View style={styles.body}>
        {tab === 'scan' && (
          <View style={styles.cameraContainer}>
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
            />

            <View style={styles.overlay}>
              <View style={styles.scanBox}>
                <View style={[styles.corner, styles.tl]} />
                <View style={[styles.corner, styles.tr]} />
                <View style={[styles.corner, styles.bl]} />
                <View style={[styles.corner, styles.br]} />
              </View>
              <Text style={styles.scanHint}>Align Kiosk QR code within box</Text>
            </View>

            {loading && (
              <View style={{ position: 'absolute', inset: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.7)' }}>
                <ActivityIndicator size="large" color={COLORS.primary} />
                <Text style={{ color: COLORS.primary, marginTop: 12, fontWeight: '800', fontSize: 14 }}>
                  Fetching Scan Record...
                </Text>
              </View>
            )}
          </View>
        )}

        {tab === 'result' && scanResult && (
          <View style={{ flex: 1, justifyContent: 'space-between' }}>
            <View style={styles.card}>
              
              <View style={styles.cardHeaderRow}>
                <View style={styles.cardHeaderLeft}>
                  <Text style={styles.fruitTitle}>
                    {formatFruitName(scanResult.fruit_type || scanResult.fruit)}
                  </Text>
                  <Text style={styles.scientific}>{scanResult.scientific || "SIGLA ANI AI"}</Text>

                  <View style={[styles.statusBadge, {
                    backgroundColor: (scanResult.status || scanResult.condition || '').toLowerCase().includes('rotten') || (scanResult.status || scanResult.condition || '').toLowerCase().includes('bulok')
                      ? COLORS.rotten
                      : COLORS.ripe
                  }]}>
                    <Text style={styles.statusText}>{scanResult.status || scanResult.conditionLabel || scanResult.condition}</Text>
                  </View>
                </View>

                {/* Fruit Image */}
                {scanResult.image_url || scanResult.image || scanResult.xai_url ? (
                  <Image 
                    source={{ 
                      uri: (scanResult.image_url || scanResult.image || scanResult.xai_url).startsWith('http')
                        ? (scanResult.image_url || scanResult.image || scanResult.xai_url)
                        : `${BASE_URL}/${(scanResult.image_url || scanResult.image || scanResult.xai_url).replace(/^\//, '')}`
                    }} 
                    style={[styles.fruitImage, { backgroundColor: '#051307' }]} 
                    resizeMode="contain"
                  />
                ) : (
                  <View style={[styles.fruitImage, { justifyContent: 'center', alignItems: 'center' }]}>
                    <Text style={{ color: COLORS.textSub, fontSize: 10, textAlign: 'center' }}>No Snapshot</Text>
                  </View>
                )}
              </View>

              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>Confidence:</Text>
                <Text style={styles.metaVal}>{scanResult.confidence}%</Text>
              </View>

              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>Quality Rating:</Text>
                <Text style={styles.metaVal}>{scanResult.rating} / 5</Text>
              </View>

              <View style={styles.recoBox}>
                <Text style={styles.recoTitle}>Storage Recommendation:</Text>
                <Text style={styles.recoText}>{scanResult.recommendation}</Text>
              </View>
            </View>

            {/* Smart Back / Scan Another Button */}
            <TouchableOpacity 
              style={styles.btn} 
              onPress={() => { 
                if (originTab === 'history') {
                  setTab('history');
                } else {
                  setScanned(false);
                  setTab('scan');
                }
              }}
            >
              <Text style={styles.btnText}>
                {originTab === 'history' ? 'Back to History' : 'Scan Another Code'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {tab === 'history' && (
          <FlatList
            data={history}
            keyExtractor={(item) => item.id.toString()}
            renderItem={({ item }) => {
              const formattedName = formatFruitName(item.fruit_type);
              return (
                <TouchableOpacity
                  style={styles.card}
                  activeOpacity={0.7}
                  onPress={() => {
                    setScanResult({
                      fruit_type: formattedName,
                      scientific: item.scientific,
                      status: item.status,
                      confidence: item.confidence,
                      rating: item.rating,
                      recommendation: item.recommendation,
                      image_url: item.image_url,
                    });
                    setOriginTab('history');
                    setTab('result');
                  }}
                  onLongPress={() => deleteHistoryItem(item.id, formattedName)}
                  delayLongPress={500}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontSize: 18, fontWeight: '800', color: COLORS.text }}>{formattedName}</Text>
                    <Text style={{ color: COLORS.primary, fontWeight: '700' }}>{item.status}</Text>
                  </View>
                  
                  {/* Clean Separated Sub-row */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 8 }}>
                    <Text style={{ color: COLORS.textSub, fontSize: 12 }}>{item.timestamp}</Text>
                    <Text style={{ color: COLORS.textSub, fontSize: 10, fontStyle: 'italic', opacity: 0.7 }}>
                      Hold to delete
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={{ color: COLORS.textSub, textAlign: 'center', marginTop: 40 }}>No previous scans recorded.</Text>
            }
          />
        )}
      </View>
    </SafeAreaView>
  );
}