import { useState, useRef, useEffect } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787';

const STATUSES = {
  processing: { label: 'Обрабатывается...', color: '#854F0B', bg: '#FAEEDA' },
  done:       { label: 'Готово',            color: '#27500A', bg: '#EAF3DE' },
  error:      { label: 'Ошибка',            color: '#791F1F', bg: '#FCEBEB' },
};

function ProgressBar({ total, processed }) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#666', marginBottom: 4 }}>
        <span>{processed.toLocaleString()} из {total.toLocaleString()}</span>
        <span>{pct}%</span>
      </div>
      <div style={{ height: 6, background: '#eee', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 3,
          background: '#0051c3',
          width: `${pct}%`,
          transition: 'width 0.5s ease'
        }} />
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{
      flex: 1, background: '#fff', borderRadius: 8,
      border: '1px solid #eee', padding: '12px 16px', textAlign: 'center'
    }}>
      <div style={{ fontSize: 26, fontWeight: 600, color: color || '#111' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function SummaryTable({ title, data }) {
  if (!data || !Object.keys(data).length) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#333' }}>{title}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          {Object.entries(data).map(([k, v]) => (
            <tr key={k} style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: '5px 8px', color: '#444' }}>{k}</td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 500 }}>
                {v.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [file,      setFile]      = useState(null);
  const [email,     setEmail]     = useState('');
  const [jobId,     setJobId]     = useState(null);
  const [status,    setStatus]    = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver,  setDragOver]  = useState(false);
  const [error,     setError]     = useState(null);
  const inputRef = useRef();

  // Polling статуса
  useEffect(() => {
    if (!jobId) return;
    if (status?.status === 'done' || status?.status === 'error') return;

    const interval = setInterval(async () => {
      try {
        const r    = await fetch(`${API}/api/status/${jobId}`);
        const data = await r.json();
        setStatus(data);
      } catch (e) {
        console.error('Status poll error:', e);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [jobId, status?.status]);

  const handleFile = (f) => {
    const allowed = ['.xml', '.csv', '.txt', '.xlsx', '.xls'];
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      setError(`Неподдерживаемый формат. Разрешены: ${allowed.join(', ')}`);
      return;
    }
    setError(null);
    setFile(f);
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);

    try {
      const form = new FormData();
      form.append('file', file);
      if (email) form.append('email', email);

      const r = await fetch(`${API}/api/upload`, {
        method: 'POST',
        body: form
      });

      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || 'Ошибка загрузки');
      }

      const { jobId: id, totalCodes } = await r.json();
      setJobId(id);
      setStatus({ status: 'processing', totalCodes, processedCodes: 0 });

    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const reset = () => {
    setFile(null);
    setJobId(null);
    setStatus(null);
    setError(null);
    setEmail('');
  };

  const s = status?.status ? STATUSES[status.status] : null;

  return (
    <div style={{
      minHeight: '100vh', background: '#f8f9fa',
      display: 'flex', alignItems: 'flex-start',
      justifyContent: 'center', padding: '40px 16px'
    }}>
      <div style={{ width: '100%', maxWidth: 620 }}>

        {/* Заголовок */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
            Проверка кодов маркировки
          </h1>
          <p style={{ fontSize: 14, color: '#666', margin: '4px 0 0' }}>
            Загрузите XML, CSV или Excel файл с кодами
          </p>
        </div>

        {!jobId ? (
          <div style={{
            background: '#fff', borderRadius: 12,
            border: '1px solid #e5e7eb', padding: 24
          }}>

            {/* Дроп-зона */}
            <div
              onClick={() => inputRef.current.click()}
              onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              style={{
                border: `2px dashed ${dragOver ? '#0051c3' : file ? '#22c55e' : '#d1d5db'}`,
                borderRadius: 10, padding: '32px 20px',
                textAlign: 'center', cursor: 'pointer',
                background: dragOver ? '#f0f4ff' : file ? '#f0fdf4' : '#fafafa',
                transition: 'all 0.15s'
              }}
            >
              <div style={{ fontSize: 32, marginBottom: 8 }}>
                {file ? '✅' : '📂'}
              </div>
              {file ? (
                <>
                  <div style={{ fontWeight: 500, fontSize: 15 }}>{file.name}</div>
                  <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
                    {(file.size / 1024).toFixed(1)} KB
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 500, fontSize: 15 }}>
                    Перетащите файл или нажмите для выбора
                  </div>
                  <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>
                    XML, CSV, TXT, XLSX, XLS
                  </div>
                </>
              )}
            </div>
            <input
              ref={inputRef} type="file" hidden
              accept=".xml,.csv,.txt,.xlsx,.xls"
              onChange={e => handleFile(e.target.files[0])}
            />

            {/* Email */}
            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 13, color: '#555', display: 'block', marginBottom: 6 }}>
                Email для получения отчёта (необязательно)
              </label>
              <input
                type="email"
                placeholder="example@company.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                style={{
                  width: '100%', padding: '9px 12px',
                  border: '1px solid #d1d5db', borderRadius: 8,
                  fontSize: 14, outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            {/* Ошибка */}
            {error && (
              <div style={{
                marginTop: 12, padding: '10px 14px',
                background: '#FCEBEB', borderRadius: 8,
                color: '#791F1F', fontSize: 13
              }}>
                ⚠️ {error}
              </div>
            )}

            {/* Кнопка */}
            <button
              onClick={upload}
              disabled={!file || uploading}
              style={{
                marginTop: 16, width: '100%',
                padding: '11px 0', fontSize: 15, fontWeight: 500,
                background: (!file || uploading) ? '#93c5fd' : '#0051c3',
                color: '#fff', border: 'none', borderRadius: 8,
                cursor: (!file || uploading) ? 'not-allowed' : 'pointer',
                transition: 'background 0.15s'
              }}
            >
              {uploading ? 'Загружаю...' : 'Обработать'}
            </button>

          </div>

        ) : (
          <div style={{
            background: '#fff', borderRadius: 12,
            border: '1px solid #e5e7eb', padding: 24
          }}>

            {/* Статус бейдж */}
            {s && (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 20,
                background: s.bg, color: s.color,
                fontSize: 13, fontWeight: 500, marginBottom: 16
              }}>
                {status.status === 'processing' && (
                  <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
                )}
                {status.status === 'done'  && '✅'}
                {status.status === 'error' && '❌'}
                {s.label}
              </div>
            )}

            <div style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>
              Job ID: <code style={{ fontSize: 11 }}>{jobId}</code>
            </div>

            {/* Прогресс */}
            {status?.status === 'processing' && (
              <ProgressBar
                total={status.totalCodes || 0}
                processed={status.processedCodes || 0}
              />
            )}

            {/* Результат */}
            {status?.status === 'done' && status.summary && (
              <>
                {/* Карточки */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
                  <StatCard label="Всего"      value={status.summary.total}    />
                  <StatCard label="Найдено"    value={status.summary.found}    color="#27500A" />
                  <StatCard label="Не найдено" value={status.summary.notFound} color="#791F1F" />
                </div>

                {/* Таблицы */}
                <SummaryTable title="По статусам"       data={status.summary.byStatus} />
                <SummaryTable title="По товарным группам" data={status.summary.byProductGroup} />
                <SummaryTable title="По владельцам"     data={status.summary.byOwner} />
                <SummaryTable title="По брендам"        data={status.summary.byBrand} />
                <SummaryTable title="По дате эмиссии"   data={status.summary.byEmissionDate} />
                <SummaryTable title="По дате производства" data={status.summary.byProducedDate} />
                {status.summary.errors && Object.keys(status.summary.errors).length > 0 && (
                  <SummaryTable title="Ошибки API" data={status.summary.errors} />
                )}

                {/* Скачать PDF */}
                
                <a href={`${API}/api/report/${jobId}`}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    gap: 8, marginTop: 16, padding: '11px 0',
                    background: '#0051c3', color: '#fff',
                    borderRadius: 8, textDecoration: 'none',
                    fontSize: 15, fontWeight: 500
                  }}
                >
                  📥 Скачать PDF отчёт
                </a>

                {email && (
                  <div style={{ marginTop: 8, fontSize: 13, color: '#666', textAlign: 'center' }}>
                    Копия отправлена на {email}
                  </div>
                )}
              </>
            )}

            {/* Ошибка */}
            {status?.status === 'error' && (
              <div style={{
                padding: '12px 16px', background: '#FCEBEB',
                borderRadius: 8, color: '#791F1F', fontSize: 14
              }}>
                {status.errorMessage || 'Произошла ошибка при обработке'}
              </div>
            )}

            {/* Кнопка сброса */}
            <button
              onClick={reset}
              style={{
                marginTop: 16, width: '100%', padding: '9px 0',
                fontSize: 14, background: 'transparent',
                border: '1px solid #d1d5db', borderRadius: 8,
                cursor: 'pointer', color: '#444'
              }}
            >
              Загрузить другой файл
            </button>

          </div>
        )}

      </div>
    </div>
  );
}

