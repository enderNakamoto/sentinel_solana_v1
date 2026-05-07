'use client';

import { useEffect, useRef, useState } from 'react';
import type { GlobeProps } from './types';

/**
 * Pure-SVG globe — wireframe sphere viewed orthographically with
 * great-circle arcs between airport pairs and animated plane sprites.
 * Drag to rotate; gentle auto-rotate when idle.
 *
 * Phase 12 M2: this is one of the swappable implementations of `Globe`.
 * Pages NEVER import this file directly — they import `./Globe`.
 *
 * Ported from design_system/page-globe.jsx with type cleanup.
 */

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface ProjectedPoint {
  x: number;
  y: number;
  visible: boolean;
}

function latLonTo3D(lat: number, lon: number, r: number): Vec3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return {
    x: -r * Math.sin(phi) * Math.cos(theta),
    y: r * Math.cos(phi),
    z: r * Math.sin(phi) * Math.sin(theta),
  };
}

function rotateY(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

function rotateX(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}

function project(p: Vec3, r: number): ProjectedPoint {
  return { x: p.x, y: -p.y, visible: p.z > -r * 0.1 };
}

export function SvgGlobe({
  markets,
  airports,
  selectedId,
  style = 'arcs',
  spin = true,
  onSelectMarket,
}: GlobeProps) {
  const [yaw, setYaw] = useState(0.5);
  const [pitch, setPitch] = useState(-0.4);
  const [t, setT] = useState(0);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(
    null,
  );

  // Animate planes along arcs.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((prev) => (prev + dt * 0.04) % 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Auto-rotate when idle.
  useEffect(() => {
    if (!spin) return;
    const id = window.setInterval(() => {
      if (dragRef.current) return;
      setYaw((y) => y + 0.0015);
    }, 30);
    return () => window.clearInterval(id);
  }, [spin]);

  const R = 260;
  const cx = 0;
  const cy = 0;

  function onMouseDown(e: React.MouseEvent) {
    dragRef.current = { x: e.clientX, y: e.clientY, yaw, pitch };
  }
  function onMouseMove(e: React.MouseEvent) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    setYaw(dragRef.current.yaw + dx * 0.005);
    setPitch(
      Math.max(-1.2, Math.min(1.2, dragRef.current.pitch + dy * 0.005)),
    );
  }
  function onMouseUp() {
    dragRef.current = null;
  }

  // Latitude / longitude lines.
  const meridians: ProjectedPoint[][] = [];
  for (let lon = -180; lon < 180; lon += 30) {
    const pts: ProjectedPoint[] = [];
    for (let lat = -90; lat <= 90; lat += 5) {
      let p = latLonTo3D(lat, lon, R);
      p = rotateY(p, yaw);
      p = rotateX(p, pitch);
      pts.push(project(p, R));
    }
    meridians.push(pts);
  }
  const parallels: ProjectedPoint[][] = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts: ProjectedPoint[] = [];
    for (let lon = -180; lon <= 180; lon += 5) {
      let p = latLonTo3D(lat, lon, R);
      p = rotateY(p, yaw);
      p = rotateX(p, pitch);
      pts.push(project(p, R));
    }
    parallels.push(pts);
  }

  // Project airports.
  const airportPts: Record<string, ProjectedPoint> = {};
  Object.entries(airports).forEach(([code, a]) => {
    let p = latLonTo3D(a.lat, a.lon, R);
    p = rotateY(p, yaw);
    p = rotateX(p, pitch);
    airportPts[code] = project(p, R);
  });

  // Build great-circle arcs per market.
  interface ArcView {
    id: string;
    pts: ProjectedPoint[];
    plane: ProjectedPoint | null;
    risk: number;
  }
  const arcs: ArcView[] = markets
    .map((f): ArcView | null => {
      const A = airports[f.from];
      const B = airports[f.to];
      if (!A || !B) return null;
      const N = 40;
      const a = latLonTo3D(A.lat, A.lon, R);
      const b = latLonTo3D(B.lat, B.lon, R);
      const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (R * R);
      const omega = Math.acos(Math.max(-1, Math.min(1, dot)));
      const sinO = Math.sin(omega) || 1e-6;
      const pts: ProjectedPoint[] = [];
      for (let i = 0; i <= N; i++) {
        const tt = i / N;
        const k1 = Math.sin((1 - tt) * omega) / sinO;
        const k2 = Math.sin(tt * omega) / sinO;
        // arc bulge: lift slightly off sphere for visual depth
        const lift = 1 + 0.06 * Math.sin(tt * Math.PI);
        let p: Vec3 = {
          x: (a.x * k1 + b.x * k2) * lift,
          y: (a.y * k1 + b.y * k2) * lift,
          z: (a.z * k1 + b.z * k2) * lift,
        };
        p = rotateY(p, yaw);
        p = rotateX(p, pitch);
        pts.push(project(p, R));
      }
      const planeIdx = Math.floor(t * N);
      const plane = pts[planeIdx] ?? null;
      return { id: f.id, pts, plane, risk: f.risk };
    })
    .filter((x): x is ArcView => x !== null);

  void style; // reserved — future swap will switch sphere render

  return (
    <svg
      width="100%"
      height="100%"
      viewBox="-400 -360 800 720"
      style={{
        position: 'absolute',
        inset: 0,
        cursor: dragRef.current ? 'grabbing' : 'grab',
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
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
        <filter id="glow">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
      </defs>

      <circle cx={cx} cy={cy} r={R + 60} fill="url(#g-glow)" />
      <circle
        cx={cx}
        cy={cy}
        r={R}
        fill="url(#g-sphere)"
        stroke="rgba(94,224,210,.15)"
        strokeWidth="1"
      />

      {meridians.map((pts, i) => (
        <polyline
          key={`m${i}`}
          points={pts
            .filter((p) => p.visible)
            .map((p) => `${p.x},${p.y}`)
            .join(' ')}
          fill="none"
          stroke="rgba(94,224,210,0.10)"
          strokeWidth="0.5"
        />
      ))}
      {parallels.map((pts, i) => (
        <polyline
          key={`p${i}`}
          points={pts
            .filter((p) => p.visible)
            .map((p) => `${p.x},${p.y}`)
            .join(' ')}
          fill="none"
          stroke="rgba(94,224,210,0.10)"
          strokeWidth="0.5"
        />
      ))}

      {arcs.map((a) => {
        const points = a.pts.filter((p) => p.visible);
        if (points.length < 2) return null;
        const isSel = a.id === selectedId;
        const color =
          a.risk < 0.25 ? '#7ee787' : a.risk < 0.4 ? '#ffb547' : '#ff5d6c';
        return (
          <g key={a.id}>
            <polyline
              points={points.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={isSel ? 2 : 0.8}
              strokeOpacity={isSel ? 0.9 : 0.4}
              filter={isSel ? 'url(#glow)' : undefined}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelectMarket?.(a.id)}
            />
            {a.plane && a.plane.visible && (
              <g transform={`translate(${a.plane.x}, ${a.plane.y})`}>
                <circle r={isSel ? 4 : 2} fill={color} filter="url(#glow)" />
                <circle r={isSel ? 2 : 1.2} fill="#fff" />
              </g>
            )}
          </g>
        );
      })}

      {Object.entries(airportPts)
        .filter(([, p]) => p.visible)
        .map(([code, p]) => (
          <g key={code} transform={`translate(${p.x}, ${p.y})`}>
            <circle r="2.5" fill="#5ee0d2" opacity="0.9" />
            <circle r="5" fill="none" stroke="#5ee0d2" strokeOpacity="0.3" />
            <text
              x="7"
              y="3"
              fill="#5ee0d2"
              fontSize="9"
              fontFamily="var(--mono)"
            >
              {code}
            </text>
          </g>
        ))}
    </svg>
  );
}
