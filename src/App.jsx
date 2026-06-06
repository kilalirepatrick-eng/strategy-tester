import { useState, useEffect, useCallback, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Area, AreaChart, BarChart, Bar, Cell } from "recharts";

// ── INDICATORS ────────────────────────────────────────────────────────────────
const Ind = {
  EMA(closes, period) {
    const result = [], mult = 2 / (period + 1);
    let ema = null;
    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) { result.push(null); continue; }
      if (ema === null) { ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period; }
      else { ema = (closes[i] - ema) * mult + ema; }
      result.push(+ema.toFixed(5));
    }
    return result;
  },
  RSI(closes, period = 14) {
    const result = []; let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) { result.push(null); continue; }
      const change = closes[i] - closes[i - 1];
      const gain = change > 0 ? change : 0, loss = change < 0 ? Math.abs(change) : 0;
      if (i <= period) {
        avgGain += gain / period; avgLoss += loss / period;
        if (i < period) { result.push(null); continue; }
      } else { avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period; }
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result.push(+(100 - 100 / (1 + rs)).toFixed(2));
    }
    return result;
  },
  crossOver: (a, b, i) => i >= 1 && a[i - 1] < b[i - 1] && a[i] > b[i],
  crossUnder: (a, b, i) => i >= 1 && a[i - 1] > b[i - 1] && a[i] < b[i],
};

// ── SYNTHETIC DATA GENERATOR ──────────────────────────────────────────────────
function generateCandles(count = 500, seed = 42) {
  let price = 1.1000, candles = [];
  let trend = 0, trendLen = 0;
  const rng = (() => { let s = seed; return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; }; })();
  for (let i = 0; i < count; i++) {
    if (trendLen <= 0) { trend = (rng() - 0.5) * 0.0002; trendLen = Math.floor(rng() * 40) + 10; }
    trendLen--;
    const volatility = 0.0008 + rng() * 0.0012;
    const open = price;
    const change = trend + (rng() - 0.5) * volatility;
    const close = +(open + change).toFixed(5);
    const hi = +Math.max(open, close, open + rng() * volatility * 0.5).toFixed(5);
    const lo = +Math.min(open, close, open - rng() * volatility * 0.5).toFixed(5);
    price = close;
    const d = new Date(2023, 0, 1); d.setHours(i);
    candles.push({ time: `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:00`, open, high: hi, low: lo, close, i });
  }
  return candles;
}

// ── BACKTEST ENGINE ───────────────────────────────────────────────────────────
function runBacktest(candles, cfg) {
  const closes = candles.map(c => c.close);
  const fast = Ind.EMA(closes, cfg.fastEMA);
  const slow = Ind.EMA(closes, cfg.slowEMA);
  const trend = Ind.EMA(closes, cfg.trendEMA);
  const rsi = Ind.RSI(closes, cfg.rsiPeriod);
  const pip = 0.0001;
  const trades = []; let openTrade = null;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    if (openTrade) {
      let closed = false;
      if (openTrade.type === "BUY") {
        if (c.low <= openTrade.sl) { openTrade.exit = openTrade.sl; openTrade.result = "LOSS"; closed = true; }
        else if (c.high >= openTrade.tp) { openTrade.exit = openTrade.tp; openTrade.result = "WIN"; closed = true; }
      } else {
        if (c.high >= openTrade.sl) { openTrade.exit = openTrade.sl; openTrade.result = "LOSS"; closed = true; }
        else if (c.low <= openTrade.tp) { openTrade.exit = openTrade.tp; openTrade.result = "WIN"; closed = true; }
      }
      if (closed) {
        openTrade.pnl = openTrade.type === "BUY"
          ? (openTrade.exit - openTrade.entry) / pip
          : (openTrade.entry - openTrade.exit) / pip;
        openTrade.exitIdx = i;
        trades.push({ ...openTrade });
        openTrade = null;
      }
    }
    if (!openTrade && fast[i] && slow[i] && trend[i] && rsi[i]) {
      const price = c.close;
      if (i >= cfg.trendEMA) {
        if (Ind.crossOver(fast, slow, i) && price > trend[i] && rsi[i] < cfg.rsiOB) {
          openTrade = { type: "BUY", entry: price, entryIdx: i, sl: price - cfg.slPips * pip, tp: price + cfg.tpPips * pip };
        } else if (Ind.crossUnder(fast, slow, i) && price < trend[i] && rsi[i] > cfg.rsiOS) {
          openTrade = { type: "SELL", entry: price, entryIdx: i, sl: price + cfg.slPips * pip, tp: price - cfg.tpPips * pip };
        }
      }
    }
  }

  // Build equity curve
  let equity = 10000, peak = 10000, maxDD = 0;
  const curve = trades.map((t, i) => {
    const dollarPerPip = (10000 * 0.01) / cfg.slPips;
    equity += t.pnl * dollarPerPip;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
    return { trade: i + 1, equity: +equity.toFixed(2), dd: +dd.toFixed(2) };
  });

  const wins = trades.filter(t => t.result === "WIN");
  const losses = trades.filter(t => t.result === "LOSS");
  const grossP = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    trades, curve, fast, slow, trend, rsi,
    stats: {
      total: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? (wins.length / trades.length * 100).toFixed(1) : 0,
      pf: grossL === 0 ? "∞" : (grossP / grossL).toFixed(2),
      totalPips: (grossP - grossL).toFixed(1),
      maxDD: maxDD.toFixed(1),
      finalEq: equity.toFixed(2),
      ret: (((equity - 10000) / 10000) * 100).toFixed(1),
      avgWin: wins.length ? (grossP / wins.length).toFixed(1) : 0,
      avgLoss: losses.length ? (grossL / losses.length).toFixed(1) : 0,
    }
  };
}

// ── COMPONENTS ────────────────────────────────────────────────────────────────
const CANDLES_SHOWN = 120;

function CandleChart({ candles, trades, fast, slow, trend, visibleStart }) {
  const slice = candles.slice(visibleStart, visibleStart + CANDLES_SHOWN);
  const tradeMarkers = trades.filter(t => t.entryIdx >= visibleStart && t.entryIdx < visibleStart + CANDLES_SHOWN);

  const priceMin = Math.min(...slice.map(c => c.low)) * 0.9995;
  const priceMax = Math.max(...slice.map(c => c.high)) * 1.0005;

  const w = 100 / CANDLES_SHOWN;

  return (
    <div style={{ position: "relative", width: "100%", height: 220, background: "#0a0e1a", borderRadius: 8, overflow: "hidden", border: "1px solid #1e2a3a" }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${CANDLES_SHOWN * 8} 220`} preserveAspectRatio="none">
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map(p => (
          <line key={p} x1="0" y1={p * 220} x2={CANDLES_SHOWN * 8} y2={p * 220} stroke="#1e2a3a" strokeWidth="1" />
        ))}
        {/* EMA lines */}
        {[{ arr: fast, color: "#00d4ff" }, { arr: slow, color: "#ff6b35" }, { arr: trend, color: "#a78bfa" }].map(({ arr, color }) => {
          const pts = slice.map((c, i) => {
            const v = arr[visibleStart + i];
            if (!v) return null;
            const y = ((priceMax - v) / (priceMax - priceMin)) * 220;
            return `${i * 8 + 4},${y}`;
          }).filter(Boolean).join(" ");
          return pts ? <polyline key={color} points={pts} fill="none" stroke={color} strokeWidth="1.5" opacity="0.8" /> : null;
        })}
        {/* Candles */}
        {slice.map((c, i) => {
          const x = i * 8 + 1;
          const openY = ((priceMax - c.open) / (priceMax - priceMin)) * 220;
          const closeY = ((priceMax - c.close) / (priceMax - priceMin)) * 220;
          const highY = ((priceMax - c.high) / (priceMax - priceMin)) * 220;
          const lowY = ((priceMax - c.low) / (priceMax - priceMin)) * 220;
          const bull = c.close >= c.open;
          const col = bull ? "#00d97e" : "#ff4757";
          const bodyTop = Math.min(openY, closeY);
          const bodyH = Math.max(Math.abs(closeY - openY), 1);
          return (
            <g key={i}>
              <line x1={x + 3} y1={highY} x2={x + 3} y2={lowY} stroke={col} strokeWidth="1" opacity="0.7" />
              <rect x={x} y={bodyTop} width="6" height={bodyH} fill={col} opacity="0.9" rx="0.5" />
            </g>
          );
        })}
        {/* Trade markers */}
        {tradeMarkers.map((t, k) => {
          const xi = (t.entryIdx - visibleStart) * 8 + 4;
          const yi = ((priceMax - t.entry) / (priceMax - priceMin)) * 220;
          const isBuy = t.type === "BUY";
          return (
            <g key={k}>
              <polygon
                points={isBuy
                  ? `${xi},${yi - 2} ${xi - 5},${yi + 8} ${xi + 5},${yi + 8}`
                  : `${xi},${yi + 2} ${xi - 5},${yi - 8} ${xi + 5},${yi - 8}`}
                fill={isBuy ? "#00d97e" : "#ff4757"}
                opacity="0.95"
              />
            </g>
          );
        })}
      </svg>
      {/* Legend */}
      <div style={{ position: "absolute", top: 8, right: 10, display: "flex", gap: 12, fontSize: 10, fontFamily: "monospace" }}>
        {[["EMA Fast", "#00d4ff"], ["EMA Slow", "#ff6b35"], ["EMA Trend", "#a78bfa"]].map(([l, c]) => (
          <span key={l} style={{ color: c }}>▬ {l}</span>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: "#0d1220",
      border: `1px solid ${accent}33`,
      borderRadius: 8,
      padding: "14px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
    }}>
      <span style={{ fontSize: 10, color: "#4a6070", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "monospace" }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color: accent, fontFamily: "'Courier New', monospace", lineHeight: 1 }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: "#4a6070", fontFamily: "monospace" }}>{sub}</span>}
    </div>
  );
}

function Slider({ label, min, max, step, value, onChange, color = "#00d4ff" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: "monospace", color: "#8899aa" }}>
        <span>{label}</span>
        <span style={{ color }}>{value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)}
        style={{ width: "100%", accentColor: color, cursor: "pointer", height: 4 }}
      />
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function StrategyTester() {
  const [cfg, setCfg] = useState({ fastEMA: 20, slowEMA: 50, trendEMA: 200, rsiPeriod: 14, rsiOB: 70, rsiOS: 30, slPips: 20, tpPips: 40 });
  const [candles] = useState(() => generateCandles(600));
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [visibleStart, setVisibleStart] = useState(200);
  const [activeTab, setActiveTab] = useState("chart");
  const [ran, setRan] = useState(false);

  const run = useCallback(() => {
    setRunning(true);
    setTimeout(() => {
      const r = runBacktest(candles, cfg);
      setResult(r);
      setRunning(false);
      setRan(true);
    }, 80);
  }, [candles, cfg]);

  useEffect(() => { run(); }, []);

  const update = (key) => (val) => setCfg(p => ({ ...p, [key]: val }));

  const tradeRows = result?.trades.slice(-20).reverse() || [];

  return (
    <div style={{
      minHeight: "100vh",
      background: "#060a12",
      color: "#ccd6f6",
      fontFamily: "'Courier New', monospace",
      padding: "0",
    }}>
      {/* Header */}
      <div style={{
        background: "linear-gradient(90deg, #0a0e1a 0%, #0d1528 100%)",
        borderBottom: "1px solid #1e2a3a",
        padding: "16px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg, #00d4ff, #a78bfa)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚡</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.08em", color: "#e8f4ff" }}>STRATEGY TESTER</div>
            <div style={{ fontSize: 10, color: "#4a6070", letterSpacing: "0.15em" }}>EMA CROSSOVER + RSI FILTER • EUR/USD 1H</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {ran && result && (
            <span style={{
              fontSize: 11,
              padding: "4px 10px",
              borderRadius: 4,
              background: +result.stats.ret >= 0 ? "#00d97e22" : "#ff475722",
              color: +result.stats.ret >= 0 ? "#00d97e" : "#ff4757",
              border: `1px solid ${+result.stats.ret >= 0 ? "#00d97e44" : "#ff475744"}`,
            }}>
              {+result.stats.ret >= 0 ? "▲" : "▼"} {result.stats.ret}% RETURN
            </span>
          )}
          <button
            onClick={run}
            disabled={running}
            style={{
              background: running ? "#1e2a3a" : "linear-gradient(135deg, #00d4ff22, #a78bfa22)",
              border: `1px solid ${running ? "#1e2a3a" : "#00d4ff55"}`,
              color: running ? "#4a6070" : "#00d4ff",
              padding: "8px 18px",
              borderRadius: 6,
              cursor: running ? "wait" : "pointer",
              fontSize: 11,
              fontFamily: "monospace",
              letterSpacing: "0.1em",
              fontWeight: 700,
              transition: "all 0.2s",
            }}
          >
            {running ? "RUNNING..." : "▶ RUN BACKTEST"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 0, minHeight: "calc(100vh - 65px)" }}>
        {/* Left: Controls */}
        <div style={{
          background: "#080c18",
          borderRight: "1px solid #1e2a3a",
          padding: "20px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 20,
          overflowY: "auto",
        }}>
          <div>
            <div style={{ fontSize: 10, color: "#4a6070", letterSpacing: "0.15em", marginBottom: 12, textTransform: "uppercase" }}>▸ Moving Averages</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Slider label="Fast EMA" min={5} max={50} step={1} value={cfg.fastEMA} onChange={update("fastEMA")} color="#00d4ff" />
              <Slider label="Slow EMA" min={20} max={100} step={5} value={cfg.slowEMA} onChange={update("slowEMA")} color="#ff6b35" />
              <Slider label="Trend EMA" min={50} max={300} step={10} value={cfg.trendEMA} onChange={update("trendEMA")} color="#a78bfa" />
            </div>
          </div>
          <div style={{ borderTop: "1px solid #1e2a3a", paddingTop: 16 }}>
            <div style={{ fontSize: 10, color: "#4a6070", letterSpacing: "0.15em", marginBottom: 12, textTransform: "uppercase" }}>▸ RSI Filter</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Slider label="RSI Period" min={7} max={21} step={1} value={cfg.rsiPeriod} onChange={update("rsiPeriod")} color="#ffd700" />
              <Slider label="Overbought" min={60} max={85} step={1} value={cfg.rsiOB} onChange={update("rsiOB")} color="#ff4757" />
              <Slider label="Oversold" min={15} max={40} step={1} value={cfg.rsiOS} onChange={update("rsiOS")} color="#00d97e" />
            </div>
          </div>
          <div style={{ borderTop: "1px solid #1e2a3a", paddingTop: 16 }}>
            <div style={{ fontSize: 10, color: "#4a6070", letterSpacing: "0.15em", marginBottom: 12, textTransform: "uppercase" }}>▸ Risk Management</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Slider label="Stop Loss (pips)" min={5} max={60} step={5} value={cfg.slPips} onChange={update("slPips")} color="#ff4757" />
              <Slider label="Take Profit (pips)" min={10} max={120} step={5} value={cfg.tpPips} onChange={update("tpPips")} color="#00d97e" />
            </div>
          </div>
          {/* R:R ratio display */}
          <div style={{ background: "#0a0e1a", border: "1px solid #1e2a3a", borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, color: "#4a6070", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em" }}>Risk:Reward Ratio</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: cfg.tpPips / cfg.slPips >= 1.5 ? "#00d97e" : "#ff6b35" }}>
              1 : {(cfg.tpPips / cfg.slPips).toFixed(2)}
            </div>
            <div style={{ fontSize: 10, color: "#4a6070", marginTop: 4 }}>
              {cfg.tpPips / cfg.slPips >= 2 ? "✓ Excellent" : cfg.tpPips / cfg.slPips >= 1.5 ? "✓ Good" : "⚠ Low R:R"}
            </div>
          </div>
          <div style={{ fontSize: 10, color: "#2a3a4a", textAlign: "center", marginTop: "auto", lineHeight: 1.6 }}>
            Synthetic EUR/USD data<br />600 candles • 1H timeframe<br />Initial balance: $10,000
          </div>
        </div>

        {/* Right: Results */}
        <div style={{ padding: "20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Stats grid */}
          {result && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              <StatCard label="Win Rate" value={`${result.stats.winRate}%`} sub={`${result.stats.wins}W / ${result.stats.losses}L`} accent="#00d4ff" />
              <StatCard label="Profit Factor" value={result.stats.pf} sub={`${result.stats.totalPips} pips net`} accent="#a78bfa" />
              <StatCard label="Max Drawdown" value={`${result.stats.maxDD}%`} sub="peak-to-trough" accent={+result.stats.maxDD > 20 ? "#ff4757" : "#ffd700"} />
              <StatCard label="Total Return" value={`${result.stats.ret}%`} sub={`$${result.stats.finalEq}`} accent={+result.stats.ret >= 0 ? "#00d97e" : "#ff4757"} />
            </div>
          )}

          {/* Tabs */}
          <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #1e2a3a" }}>
            {[["chart", "📈 PRICE CHART"], ["equity", "💰 EQUITY CURVE"], ["rsi", "📊 RSI"], ["trades", "📋 TRADE LOG"]].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                style={{
                  background: "none",
                  border: "none",
                  borderBottom: `2px solid ${activeTab === id ? "#00d4ff" : "transparent"}`,
                  color: activeTab === id ? "#00d4ff" : "#4a6070",
                  padding: "8px 16px",
                  cursor: "pointer",
                  fontSize: 10,
                  fontFamily: "monospace",
                  letterSpacing: "0.1em",
                  transition: "all 0.15s",
                  marginBottom: -1,
                }}
              >{label}</button>
            ))}
          </div>

          {/* Tab content */}
          {activeTab === "chart" && result && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <CandleChart candles={candles} trades={result.trades} fast={result.fast} slow={result.slow} trend={result.trend} visibleStart={visibleStart} />
              {/* Scrubber */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#4a6070" }}>
                  <span>Viewing candles {visibleStart}–{visibleStart + CANDLES_SHOWN}</span>
                  <span>▸ Drag to scroll</span>
                </d
