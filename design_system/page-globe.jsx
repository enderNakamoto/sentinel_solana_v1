const { FlightRoute, RiskBar } = window;

// Mercator-ish projection onto a sphere viewed in 3D using CSS 3D + great-circle arcs.
// We render the globe as a wireframe sphere using SVG + transform: rotate3d, plus arcs as SVG paths
// projected from lat/lon to a 2D dome view.

function latLonTo3D(lat, lon, r) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return {
    x: -r * Math.sin(phi) * Math.cos(theta),
    y: r * Math.cos(phi),
    z: r * Math.sin(phi) * Math.sin(theta),
  };
}

function rotateY(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}
function rotateX(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}

function project(p, r) {
  // simple orthographic
  return { x: p.x, y: -p.y, visible: p.z > -r * 0.1 };
}

function PageGlobe({ go }) {
  const { FLIGHTS, AIRPORTS } = window.SENTINEL;
  const [yaw, setYaw] = useState(0.5);
  const [pitch, setPitch] = useState(-0.4);
  const [t, setT] = useState(0);
  const [hover, setHover] = useState(null);
  const [selected, setSelected] = useState(FLIGHTS[0].id);
  const dragRef = useRef(null);
  const stageRef = useRef(null);

  // animate planes
  useEffect(() => {
    let raf, last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now;
      setT(prev => (prev + dt * 0.04) % 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // gentle auto-rotate when not dragging
  useEffect(() => {
    if (dragRef.current) return;
    const id = setInterval(() => setYaw(y => y + 0.0015), 30);
    return () => clearInterval(id);
  }, []);

  const R = 260;
  const cx = 0, cy = 0;

  function onMouseDown(e) {
    dragRef.current = { x: e.clientX, y: e.clientY, yaw, pitch };
  }
  function onMouseMove(e) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    setYaw(dragRef.current.yaw + dx * 0.005);
    setPitch(Math.max(-1.2, Math.min(1.2, dragRef.current.pitch + dy * 0.005)));
  }
  function onMouseUp() { dragRef.current = null; }

  // Generate latitude/longitude lines
  const meridians = [];
  for (let lon = -180; lon < 180; lon += 30) {
    const pts = [];
    for (let lat = -90; lat <= 90; lat += 5) {
      let p = latLonTo3D(lat, lon, R);
      p = rotateY(p, yaw); p = rotateX(p, pitch);
      pts.push(project(p, R));
    }
    meridians.push(pts);
  }
  const parallels = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 5) {
      let p = latLonTo3D(lat, lon, R);
      p = rotateY(p, yaw); p = rotateX(p, pitch);
      pts.push(project(p, R));
    }
    parallels.push(pts);
  }

  // Project airports
  const airportPts = {};
  Object.entries(AIRPORTS).forEach(([code, a]) => {
    let p = latLonTo3D(a.lat, a.lon, R);
    p = rotateY(p, yaw); p = rotateX(p, pitch);
    airportPts[code] = project(p, R);
  });

  // For each flight: build great-circle arc
  const arcs = FLIGHTS.map(f => {
    const A = AIRPORTS[f.from], B = AIRPORTS[f.to];
    if (!A || !B) return null;
    const N = 40;
    const pts = [];
    // slerp on sphere
    const a = latLonTo3D(A.lat, A.lon, R);
    const b = latLonTo3D(B.lat, B.lon, R);
    const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (R * R);
    const omega = Math.acos(Math.max(-1, Math.min(1, dot)));
    const sinO = Math.sin(omega) || 1e-6;
    for (let i = 0; i <= N; i++) {
      const tt = i / N;
      const k1 = Math.sin((1 - tt) * omega) / sinO;
      const k2 = Math.sin(tt * omega) / sinO;
      // arc bulge: lift slightly off sphere for visual depth
      const lift = 1 + 0.06 * Math.sin(tt * Math.PI);
      let p = { x: (a.x * k1 + b.x * k2) * lift, y: (a.y * k1 + b.y * k2) * lift, z: (a.z * k1 + b.z * k2) * lift };
      p = rotateY(p, yaw); p = rotateX(p, pitch);
      pts.push(project(p, R));
    }
    // plane position along arc
    const planeIdx = Math.floor(t * N);
    const planeP = pts[planeIdx];
    return { id: f.id, pts, plane: planeP, risk: f.risk, flight: f };
  }).filter(Boolean);

  const sel = FLIGHTS.find(f => f.id === selected);

  return (
    <div className="globe-stage" ref={stageRef}
         onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
      {/* Stars */}
      <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(1px 1px at 10% 20%, #fff5, transparent), radial-gradient(1px 1px at 80% 70%, #fff4, transparent), radial-gradient(1px 1px at 30% 80%, #fff3, transparent), radial-gradient(1px 1px at 60% 10%, #fff5, transparent), radial-gradient(1px 1px at 90% 30%, #fff3, transparent)', backgroundSize: '600px 600px' }} />

      {/* Globe */}
      <svg width="100%" height="100%" viewBox={`-400 -360 800 720`}
           style={{ position: 'absolute', inset: 0, cursor: dragRef.current ? 'grabbing' : 'grab' }}>
        <defs>
          <radialGradient id="g-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#5ee0d2" stopOpacity="0.06" />
            <stop offset="0.7" stopColor="#5ee0d2" stopOpacity="0.02" />
            <stop offset="1" stopColor="#5ee0d2" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="g-sphere" cx="35%" cy="35%" r="65%">
            <stop offset="0" stopColor="#0e1622" />
            <stop offset="1" stopColor="#03060a" />
          </radialGradient>
          <linearGradient id="g-arc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ffb547" stopOpacity="0" />
            <stop offset="0.5" stopColor="#ffb547" stopOpacity="0.9" />
            <stop offset="1" stopColor="#5ee0d2" stopOpacity="0.9" />
          </linearGradient>
          <filter id="glow"><feGaussianBlur stdDeviation="2.5" /></filter>
        </defs>

        {/* Outer glow */}
        <circle cx={cx} cy={cy} r={R + 60} fill="url(#g-glow)" />
        {/* Sphere */}
        <circle cx={cx} cy={cy} r={R} fill="url(#g-sphere)" stroke="rgba(94,224,210,.15)" strokeWidth="1" />

        {/* Meridians/parallels */}
        {meridians.map((pts, i) => (
          <polyline key={'m' + i} points={pts.filter(p => p.visible).map(p => `${p.x},${p.y}`).join(' ')}
                    fill="none" stroke="rgba(94,224,210,0.10)" strokeWidth="0.5" />
        ))}
        {parallels.map((pts, i) => (
          <polyline key={'p' + i} points={pts.filter(p => p.visible).map(p => `${p.x},${p.y}`).join(' ')}
                    fill="none" stroke="rgba(94,224,210,0.10)" strokeWidth="0.5" />
        ))}

        {/* Arcs */}
        {arcs.map(a => {
          const points = a.pts.filter(p => p.visible);
          if (points.length < 2) return null;
          const isSel = a.id === selected;
          const color = a.risk < 0.25 ? '#7ee787' : a.risk < 0.4 ? '#ffb547' : '#ff5d6c';
          return (
            <g key={a.id}>
              <polyline points={points.map(p => `${p.x},${p.y}`).join(' ')}
                        fill="none" stroke={color}
                        strokeWidth={isSel ? 2 : 0.8}
                        strokeOpacity={isSel ? 0.9 : 0.4}
                        filter={isSel ? 'url(#glow)' : undefined}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSelected(a.id)} />
              {/* Plane sprite */}
              {a.plane && a.plane.visible && (
                <g transform={`translate(${a.plane.x}, ${a.plane.y})`}>
                  <circle r={isSel ? 4 : 2} fill={color} filter="url(#glow)" />
                  <circle r={isSel ? 2 : 1.2} fill="#fff" />
                </g>
              )}
            </g>
          );
        })}

        {/* Airports */}
        {Object.entries(airportPts).filter(([_, p]) => p.visible).map(([code, p]) => (
          <g key={code} transform={`translate(${p.x}, ${p.y})`}>
            <circle r="2.5" fill="#5ee0d2" opacity="0.9" />
            <circle r="5" fill="none" stroke="#5ee0d2" strokeOpacity="0.3" />
            <text x="7" y="3" fill="#5ee0d2" fontSize="9" fontFamily="JetBrains Mono">{code}</text>
          </g>
        ))}
      </svg>

      {/* LEFT panel: live markets list */}
      <div className="globe-overlay-l">
        <div className="panel">
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="card-title">Live Markets</div>
            <span className="live-pill" style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>{FLIGHTS.length} open</span>
          </div>
          <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            {FLIGHTS.map(f => {
              const active = f.id === selected;
              return (
                <div key={f.id} onClick={() => setSelected(f.id)}
                     style={{
                       padding: '10px 8px', borderRadius: 6, cursor: 'pointer',
                       background: active ? 'var(--bg-2)' : 'transparent',
                       borderLeft: '2px solid ' + (active ? 'var(--amber)' : 'transparent'),
                     }}>
                  <div className="row between">
                    <div className="num" style={{ fontSize: 12 }}>{f.id}</div>
                    <span className="num muted" style={{ fontSize: 10 }}>{f.depTs}</span>
                  </div>
                  <div className="row between" style={{ marginTop: 4 }}>
                    <span className="num" style={{ fontSize: 11, color: 'var(--ink-2)' }}>{f.from} → {f.to}</span>
                    <span className="num" style={{ fontSize: 11, color: f.risk < 0.25 ? 'var(--green)' : f.risk < 0.4 ? 'var(--amber)' : 'var(--red)' }}>
                      {Math.round(f.risk * 100)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* RIGHT panel: selected market */}
      <div className="globe-overlay-r">
        {sel && (
          <div className="panel">
            <div className="row between">
              <div>
                <div className="num" style={{ fontSize: 18 }}>{sel.id}</div>
                <div className="carrier">{sel.carrier} · {sel.date}</div>
              </div>
              <span className="badge amber">{sel.depTs}</span>
            </div>

            <div className="panel-section">
              <div className="row" style={{ gap: 14, alignItems: 'center', marginTop: 4 }}>
                <div>
                  <div className="num" style={{ fontSize: 22 }}>{sel.from}</div>
                  <div className="muted mono" style={{ fontSize: 10 }}>{sel.dep}</div>
                </div>
                <div style={{ flex: 1, height: 1, background: 'var(--ink-4)', position: 'relative' }}>
                  <div style={{ position: 'absolute', top: -6, left: '50%', transform: 'translateX(-50%)', color: 'var(--amber)', fontSize: 11 }}>✈</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="num" style={{ fontSize: 22 }}>{sel.to}</div>
                  <div className="muted mono" style={{ fontSize: 10 }}>{sel.arr}</div>
                </div>
              </div>
            </div>

            <div className="panel-section col" style={{ gap: 8 }}>
              <div className="row between"><span className="muted" style={{ fontSize: 11 }}>Delay odds</span><span className="num" style={{ fontSize: 12 }}>{Math.round(sel.risk * 100)}%</span></div>
              <div className="row between"><span className="muted" style={{ fontSize: 11 }}>Premium</span><span className="num" style={{ fontSize: 12 }}>{sel.premium.toFixed(2)} USDC</span></div>
              <div className="row between"><span className="muted" style={{ fontSize: 11 }}>Payout</span><span className="num" style={{ fontSize: 12, color: 'var(--cyan)' }}>{sel.payout} USDC</span></div>
              <div className="row between"><span className="muted" style={{ fontSize: 11 }}>Threshold</span><span className="num" style={{ fontSize: 12 }}>&gt;{sel.threshold}min</span></div>
              <div className="row between"><span className="muted" style={{ fontSize: 11 }}>Pool TVL</span><span className="num" style={{ fontSize: 12 }}>${sel.tvl.toLocaleString()}</span></div>
              <div className="row between"><span className="muted" style={{ fontSize: 11 }}>Coverage left</span><span className="num" style={{ fontSize: 12 }}>{sel.slots} slots</span></div>
            </div>

            <button className="btn primary" style={{ width: '100%', marginTop: 14 }} onClick={() => go('buy')}>Cover {sel.id} →</button>
          </div>
        )}

        {/* Legend */}
        <div className="panel" style={{ marginTop: 14, padding: 14 }}>
          <div className="card-title" style={{ marginBottom: 10 }}>Legend</div>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            {[['var(--green)', 'Low risk'], ['var(--amber)', 'Medium'], ['var(--red)', 'High'], ['var(--cyan)', 'Airport']].map(([c, l]) => (
              <div key={l} className="row" style={{ gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 50, background: c, boxShadow: '0 0 6px ' + c }} />
                <span className="muted mono" style={{ fontSize: 10 }}>{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom hint */}
      <div style={{ position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '.15em' }}>
        DRAG TO ROTATE · {arcs.length} ACTIVE FLIGHTS · LIVE
      </div>
    </div>
  );
}

window.PageGlobe = PageGlobe;
