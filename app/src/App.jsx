
import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { Upload, FileText, CheckCircle, AlertCircle, ArrowRight, Download, Server, RefreshCw, HelpCircle } from 'lucide-react';
import { readCJISFile, parseCSV } from './utils/csvParser';

function App() {
  const [step, setStep] = useState(1); // 1: Upload & Analyze, 2: Result
  const [stores, setStores] = useState({});
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);

  // Normalize string for matching (remove spaces, full-width/half-width conversion)
  const normalize = (str) => {
    if (!str) return "";
    return String(str)
      .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // Full-width to half-width
      .replace(/\s+/g, "") // Remove spaces
      .toLowerCase();
  };

  const handleFolderUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    setLoading(true);
    // Group files by folder
    const filesByPath = {};
    files.forEach(file => {
      // webkitRelativePath is like "Folder/Sub/File.csv"
      const pathParts = file.webkitRelativePath.split('/');
      // Usually the immediate parent folder of the file is what we want, 
      // or the top level folder if user uploaded a root folder containing store folders.
      // Logic: If user uploads "AllStores", path is "AllStores/Sano/file.csv". Store is "Sano".
      // If user uploads "Sano", path is "Sano/file.csv". Store is "Sano".
      // Let's assume the folder containing the CSV is the specific store folder.
      const parentFolder = pathParts.length > 1 ? pathParts[pathParts.length - 2] : 'Root';

      if (!filesByPath[parentFolder]) {
        filesByPath[parentFolder] = [];
      }
      filesByPath[parentFolder].push(file);
    });

    const newStores = { ...stores };

    for (const [folderName, folderFiles] of Object.entries(filesByPath)) {
      let hudoFile = folderFiles.find(f => f.name.toLowerCase().includes('hudoaddlist'));
      let zaikoFile = folderFiles.find(f => f.name.toLowerCase().includes('zaikokin'));

      if (hudoFile || zaikoFile) {
        let storeName = folderName;
        let zaikoData = null;
        let hudoData = null;

        if (zaikoFile) {
          try {
            const content = await readCJISFile(zaikoFile);
            const rows = parseCSV(content);

            // Extract Store Name
            if (rows.length > 5) {
              // Search first few rows for "店舗"
              for (let r = 0; r < 5; r++) {
                const row = rows[r];
                const storeIdx = row.findIndex(c => c && (c.includes('店舗') || c === '店舗名'));
                if (storeIdx !== -1 && row.length > storeIdx + 1) {
                  const val = row[storeIdx + 1];
                  if (val && val.trim()) {
                    storeName = val.trim();
                    break;
                  }
                }
              }
            }

            const headerRowIndex = rows.findIndex(row => {
              const strRow = row.map(c => String(c));
              // Strict check: Must have "薬品名" AND ("処方数量" OR "レセ電コード" OR "No.")
              const hasName = strRow.some(c => c.includes('薬品名') || c.includes('商品名'));
              const hasOther = strRow.some(c => c.includes('処方数量') || c.includes('使用量') || c.includes('レセ電コード') || c === 'No.');
              return hasName && hasOther;
            });

            if (headerRowIndex !== -1) {
              const headers = rows[headerRowIndex].map(h => String(h)); // Ensure strings
              const nameIdx = headers.findIndex(h => h.includes('薬品名') || h.includes('商品名'));
              let usageIdx = headers.findIndex(h => h.includes('処方数量') || h.includes('使用量') || h.includes('総使用量'));

              // Fallback logic for usage column
              // If usageIdx is -1, or if it is found but we want to be sure about column 20 if the header name is weird
              if (usageIdx === -1) {
                // Check if column 20 looks like usage?
                usageIdx = 20;
              }

              if (nameIdx !== -1) {
                const usageList = [];
                for (let i = headerRowIndex + 1; i < rows.length; i++) {
                  const row = rows[i];
                  if (row.length > nameIdx && row[nameIdx]) {
                    // Normalization
                    const rawName = row[nameIdx];

                    // Usage Extraction
                    let qtyVal = 0;

                    // Strategy 1: Use detected usageIdx
                    if (usageIdx !== -1 && row.length > usageIdx) {
                      let val = row[usageIdx];
                      if (typeof val === 'string') val = val.replace(/,/g, '').trim();
                      if (val && !isNaN(parseFloat(val))) qtyVal = parseFloat(val);
                    }

                    // Strategy 2: Fallback to Col 20 if Strategy 1 yielded 0 or invalid, AND we suspect Col 20 is better
                    // (Unless usageIdx WAS 20).
                    if ((qtyVal === 0) && usageIdx !== 20 && row.length > 20) {
                      let val = row[20];
                      if (typeof val === 'string') val = val.replace(/,/g, '').trim();
                      const uVal = parseFloat(val);
                      if (!isNaN(uVal) && uVal > 0) qtyVal = uVal;
                    }

                    usageList.push({
                      name: rawName,
                      normalizedName: normalize(rawName),
                      usage: qtyVal
                    });
                  }
                }
                zaikoData = usageList;
              }
            }
          } catch (err) {
            console.error(`Error parsing ZaikoKin for ${folderName}`, err);
          }
        }

        if (hudoFile) {
          try {
            const content = await readCJISFile(hudoFile);
            const rows = parseCSV(content);
            const headerRowIndex = rows.findIndex(row => row[0] && (row[0] === 'No.' || row[0] === 'No'));

            if (headerRowIndex !== -1) {
              const headers = rows[headerRowIndex];
              const nameIdx = headers.findIndex(h => h === '薬品名');
              const stockIdx = headers.findIndex(h => h === '在庫数量' || h === '在庫数');
              const expiryIdx = headers.findIndex(h => h === '使用期限');
              const priceIdx = headers.findIndex(h => h === '薬価');

              if (nameIdx !== -1) {
                const deadstockList = [];
                for (let i = headerRowIndex + 1; i < rows.length; i++) {
                  const row = rows[i];
                  if (row.length > nameIdx && row[nameIdx]) {
                    deadstockList.push({
                      name: row[nameIdx],
                      normalizedName: normalize(row[nameIdx]),
                      stock: parseFloat(row[stockIdx]) || 0,
                      expiry: row[expiryIdx] || '',
                      price: parseFloat(row[priceIdx]) || 0,
                    });
                  }
                }
                hudoData = deadstockList;
              }
            }
          } catch (err) {
            console.error(`Error parsing HudoAddList for ${folderName}`, err);
          }
        }

        // Use valid store name (e.g., from Zaiko)
        // Check if store already exists (e.g. from another partial folder scan?)
        // Unlikely with folder grouping.
        newStores[storeName] = {
          name: storeName,
          hudo: hudoData,
          zaiko: zaikoData,
          files: { hudo: !!hudoFile, zaiko: !!zaikoFile }
        };
      }
    }

    setStores(newStores);
    setLoading(false);
  };

  const executeMatching = () => {
    setLoading(true);
    const results = [];
    const storeNames = Object.keys(stores);

    storeNames.forEach(sourceStoreName => {
      const sourceStore = stores[sourceStoreName];
      if (!sourceStore.hudo) return;

      sourceStore.hudo.forEach(item => {
        if (!item.name) return;

        const usageMap = {};
        storeNames.forEach(targetStoreName => {
          if (sourceStoreName === targetStoreName) {
            usageMap[targetStoreName] = '-';
            return;
          }
          const targetStore = stores[targetStoreName];
          if (!targetStore.zaiko) {
            usageMap[targetStoreName] = '?';
            return;
          }

          // Fuzzy/Normalized Match
          const match = targetStore.zaiko.find(z => z.normalizedName === item.normalizedName);
          usageMap[targetStoreName] = match ? match.usage : 0;
        });

        results.push({
          provider: sourceStoreName,
          item: item.name,
          stock: item.stock,
          expiry: item.expiry,
          price: item.price,
          usages: usageMap
        });
      });
    });

    setMatches(results);
    setLoading(false);
    setStep(2); // Result View
  };

  const downloadExcel = () => {
    // Generate dynamic headers based on stores
    const allStores = Object.keys(stores);

    const rows = matches.map(m => {
      const row = {
        '提供店舗': m.provider,
        '薬品名': m.item,
        '在庫数': m.stock,
        '使用期限': m.expiry,
        '薬価': m.price,
        '在庫金額': m.stock * m.price
      };
      // Add dynamic usage columns
      allStores.forEach(store => {
        row[`${store} (使用量)`] = m.usages[store];
      });
      return row;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "デッドストック分析");
    XLSX.writeFile(wb, "deadstock_analysis.xlsx");
  };

  const reset = () => {
    setStores({});
    setMatches([]);
    setStep(1);
    setLoading(false);
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Deadstock Matching</h1>
        <p>不動品と使用実績をマッチングし、店舗間移動を最適化します</p>
      </div>

      <div className="steps">
        <div className={`step ${step === 1 ? 'active' : ''} `}>
          <div className="step-number">1</div>
          <span>Upload & Analyze</span>
        </div>
        <div className={`step ${step === 2 ? 'active' : ''} `}>
          <div className="step-number">2</div>
          <span>Result</span>
        </div>
      </div>

      {step === 1 && (
        <div className="card">
          <div
            className={`drop-zone ${loading ? 'loading' : ''}`}
            onClick={() => fileInputRef.current.click()}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              setLoading(true);

              const items = e.dataTransfer.items;
              const files = [];
              const scanFiles = async (entry) => {
                if (entry.isFile) {
                  return new Promise(resolve => entry.file(f => {
                    // Attach webkitRelativePath for consistency with input[type=file]
                    Object.defineProperty(f, 'webkitRelativePath', {
                      value: entry.fullPath.substring(1), // Remove leading slash
                      writable: false
                    });
                    files.push(f);
                    resolve();
                  }));
                } else if (entry.isDirectory) {
                  const reader = entry.createReader();
                  const readEntries = () => new Promise(resolve => {
                    reader.readEntries(async entries => {
                      if (entries.length === 0) resolve();
                      else {
                        await Promise.all(entries.map(scanFiles));
                        await readEntries();
                        resolve();
                      }
                    });
                  });
                  await readEntries();
                }
              };

              for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.webkitGetAsEntry) {
                  const entry = item.webkitGetAsEntry();
                  if (entry) await scanFiles(entry);
                }
              }

              if (files.length > 0) {
                // Reuse handleFolderUpload logic but with file list
                // Create synthetic event-like object
                const syntheticEvent = { target: { files: files } };
                handleFolderUpload(syntheticEvent);
              } else {
                setLoading(false);
              }
            }}
          >
            <Upload size={48} color="var(--accent)" />
            <h2>フォルダをドロップ</h2>
            <p>クリックして選択、またはD&Dで追加（複数回可）</p>
            <input
              type="file"
              multiple
              ref={(input) => {
                fileInputRef.current = input;
                if (input) {
                  input.setAttribute("webkitdirectory", "");
                  input.setAttribute("directory", "");
                }
              }}
              style={{ display: 'none' }}
              onChange={handleFolderUpload}
            />
          </div>

          <div style={{ marginTop: '3rem', padding: '1.5rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <h3 style={{ marginTop: 0, fontSize: '1.1rem', color: 'var(--accent)' }}><HelpCircle size={18} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: '0.5rem' }} />使い方</h3>
            <ol style={{ paddingLeft: '1.5rem', lineHeight: '1.6', color: 'rgba(255,255,255,0.8)' }}>
              <li>
                各店舗のフォルダを作成し（例：「佐野」「あやめ」）、以下の2つのCSVファイルを保存してください。
                <ul style={{ margin: '0.5rem 0' }}>
                  <li>
                    <strong>HudoAddList.csv (不動品リスト)</strong>
                    <br />
                    <span style={{ fontSize: '0.85rem', color: 'gray' }}>ミザル ＞ 在庫管理 ＞ 余剰在庫登録 ＞ 回転数0以下 ＞ 期間4ヶ月前から（任意）</span>
                  </li>
                  <li>
                    <strong>ZaikoKin.csv (使用実績リスト)</strong>
                    <br />
                    <span style={{ fontSize: '0.85rem', color: 'gray' }}>ミザル ＞ 在庫管理 ＞ 在庫分析表 ＞ 過去3ヶ月CSV出力</span>
                  </li>
                </ul>
              </li>
              <li>この画面の枠内に店舗フォルダごとドラッグ＆ドロップしてください（またはクリックして選択）。</li>
              <li>全店舗の追加が終わったら「マッチング実行」ボタンを押してください。</li>
            </ol>
          </div>

          {Object.keys(stores).length > 0 && (
            <div style={{ marginTop: '2rem' }}>
              <h3>登録済み店舗: {Object.keys(stores).length}件</h3>
              <div className="store-list">
                {Object.values(stores).map((store, idx) => (
                  <div key={idx} className="store-item">
                    <div className="store-name">{store.name}</div>
                    <div className={`file-status ${store.files.hudo ? 'found' : ''}`}>
                      {store.files.hudo ? <CheckCircle size={16} /> : <AlertCircle size={16} />} 不動品
                    </div>
                    <div className={`file-status ${store.files.zaiko ? 'found' : ''}`}>
                      {store.files.zaiko ? <CheckCircle size={16} /> : <AlertCircle size={16} />} 使用量
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ textAlign: 'center', marginTop: '2rem' }}>
                <button className="btn btn-primary" onClick={executeMatching} disabled={loading}>
                  {loading ? '処理中...' : <>マッチング実行 <ArrowRight size={20} /></>}
                </button>
                <button className="btn" style={{ marginLeft: '1rem' }} onClick={reset}>
                  リセット
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
            <h2>分析完了</h2>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button className="btn" onClick={reset}>
                <RefreshCw size={20} /> 最初に戻る
              </button>
              <button className="btn btn-success" onClick={downloadExcel}>
                <Download size={20} /> Excelダウンロード
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
            {Object.keys(stores).map(storeName => {
              // Calculate summary for this store
              const storeMatches = matches.filter(m => m.provider === storeName);
              const totalAmount = storeMatches.reduce((sum, m) => sum + (m.stock * m.price), 0);

              // Calculate matchable amount
              // A match is valid if at least one other store has usage > 0
              const matchableAmount = storeMatches
                .filter(m => {
                  return Object.entries(m.usages).some(([target, usage]) => {
                    return target !== storeName && usage > 0 && usage !== '?' && usage !== '-';
                  });
                })
                .reduce((sum, m) => sum + (m.stock * m.price), 0);

              return (
                <div key={storeName} style={{
                  padding: '1.5rem',
                  background: 'rgba(255,255,255,0.05)',
                  borderRadius: '0.8rem',
                  border: '1px solid var(--border)'
                }}>
                  <h3 style={{ marginTop: 0, color: 'var(--accent)' }}>{storeName}</h3>
                  <div style={{ marginBottom: '0.5rem', display: 'flex', justifyContent: 'space-between' }}>
                    <span>不動品総額:</span>
                    <span style={{ fontWeight: 'bold' }}>¥{Math.round(totalAmount).toLocaleString()}</span>
                  </div>
                  <div style={{ marginBottom: '0.5rem', display: 'flex', justifyContent: 'space-between', color: 'var(--success)' }}>
                    <span>移動可能金額:</span>
                    <span style={{ fontWeight: 'bold' }}>¥{Math.round(matchableAmount).toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'gray', marginTop: '1rem' }}>
                    不動品数: {storeMatches.length} 品目
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: '2rem', textAlign: 'center', color: 'gray' }}>
            <p>※詳細なリストはExcelをダウンロードしてご確認ください。</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
