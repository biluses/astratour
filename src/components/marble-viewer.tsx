'use client';

import { useEffect, useRef, useState } from 'react';
import { Box, Expand, LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { meanLuminance } from '@/lib/capture-checks';
import { cn } from '@/lib/utils';

type Room = { id: string; name: string; thumbUrl: string | null };
const FADE_MS = 350;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Mean luminance (0-255) of a thumbnail, or null if it cannot be read. */
async function thumbLuminance(url: string | null): Promise<number | null> {
  if (!url) return null;
  try {
    const bitmap = await createImageBitmap(await (await fetch(url, { credentials: 'same-origin' })).blob());
    const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, 64, 64);
    bitmap.close();
    const rgba = context.getImageData(0, 0, 64, 64).data;
    const gray = new Float32Array(64 * 64);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    return meanLuminance(gray) || null;
  } catch { return null; }
}

/** Per-room CSS brightness factors that pull every room towards the tour's mean thumbnail luminance. */
async function brightnessFactors(rooms: Room[]): Promise<number[]> {
  const means = await Promise.all(rooms.map(room => thumbLuminance(room.thumbUrl)));
  const known = means.filter((m): m is number => m !== null);
  const target = known.reduce((a, b) => a + b, 0) / (known.length || 1);
  return means.map(mean => mean ? Math.min(1.25, Math.max(0.8, target / mean)) : 1);
}

/**
 * Fixed-point viewer for Marble rooms (port of capture-study/marble/tour.html without free movement): the camera stays
 * at the capture point and the user drags to look around. Switching rooms fades to black and replaces the splat.
 */
export function MarbleViewer({ tourId, rooms }: { tourId: string; rooms: Room[] }) {
  const [opened, setOpened] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const fade = useRef<HTMLDivElement>(null);
  const show = useRef<((index: number) => void) | null>(null);
  const roomsRef = useRef(rooms);
  const activeRef = useRef(active);
  roomsRef.current = rooms;
  activeRef.current = active;
  const roomKey = rooms.map(room => room.id).join();

  useEffect(() => {
    const container = host.current;
    const fader = fade.current;
    if (!opened || !container || !fader) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const THREE = await import('three');
      const { SplatMesh } = await import('@sparkjsdev/spark');
      const factors = await brightnessFactors(roomsRef.current);
      if (disposed) return;
      const renderer = new THREE.WebGLRenderer({ antialias: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      const canvas = renderer.domElement;
      canvas.style.touchAction = 'none';
      canvas.style.display = 'block';
      container.appendChild(canvas);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 200);
      const flip = new THREE.Group();
      flip.rotation.x = Math.PI; // Marble splats are in the OpenCV frame (y down): flip into three.js (y up).
      scene.add(flip);
      const resize = () => {
        const { clientWidth: w, clientHeight: h } = container;
        renderer.setSize(w, h);
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(container);
      resize();

      // Yaw 0 looks at the room's first photo: azimuths are submitted relative to it.
      let yaw = 0, pitch = 0;
      let drag: { x: number; y: number } | null = null;
      const look = (dx: number, dy: number) => { yaw -= dx * 0.2; pitch = Math.max(-80, Math.min(80, pitch - dy * 0.2)); };
      canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', e => {
        if (!drag) return;
        look(e.clientX - drag.x, e.clientY - drag.y); // grab the scene, like Street View
        drag = { x: e.clientX, y: e.clientY };
      });
      const release = () => { drag = null; };
      canvas.addEventListener('pointerup', release);
      canvas.addEventListener('pointercancel', release);
      const onKey = (e: KeyboardEvent) => {
        const step = { ArrowLeft: [-75, 0], ArrowRight: [75, 0], ArrowUp: [0, -75], ArrowDown: [0, 75] }[e.key];
        if (step) { e.preventDefault(); look(step[0], step[1]); }
      };
      container.addEventListener('keydown', onKey);
      renderer.setAnimationLoop(() => {
        camera.rotation.set(0, 0, 0, 'YXZ');
        camera.rotateY(-yaw * Math.PI / 180);
        camera.rotateX(-pitch * Math.PI / 180);
        renderer.render(scene, camera);
      });

      // Phones get the 500k splat (~7 MB) instead of full resolution (~29 MB).
      const file = window.matchMedia('(pointer: coarse)').matches ? 'splat-500k.spz' : 'splat-full.spz';
      let current: InstanceType<typeof SplatMesh> | null = null;
      let token = 0;
      show.current = async (index: number) => {
        const mine = ++token;
        setStatus('loading');
        fader.style.opacity = '1';
        await wait(FADE_MS);
        if (mine !== token || disposed) return;
        if (current) { flip.remove(current); current.dispose(); current = null; }
        const room = roomsRef.current[index];
        const next = new SplatMesh({ url: `/api/tours/${tourId}/rooms/${room.id}/${file}` });
        try { await next.initialized; } catch {
          next.dispose();
          if (mine === token && !disposed) setStatus('error');
          return;
        }
        if (mine !== token || disposed) { next.dispose(); return; }
        current = next;
        flip.add(next);
        yaw = 0; pitch = 0;
        canvas.style.filter = `brightness(${factors[index] ?? 1})`;
        fader.style.opacity = '0';
        setStatus('ready');
      };
      cleanup = () => {
        renderer.setAnimationLoop(null);
        observer.disconnect();
        container.removeEventListener('keydown', onKey);
        current?.dispose();
        renderer.dispose();
        canvas.remove();
      };
      show.current(activeRef.current);
    })().catch(() => { if (!disposed) setStatus('error'); });
    return () => { disposed = true; show.current = null; cleanup(); };
  }, [opened, attempt, tourId, roomKey]);

  function select(index: number) {
    if (index === active && status !== 'error') return;
    setActive(index);
    show.current?.(index);
  }

  return <div ref={frame} className="overflow-hidden rounded-xl border border-border bg-background">
    <div className="relative aspect-[4/3] min-h-80 overflow-hidden bg-black sm:aspect-[16/9]">
      {!opened ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <Box className="size-10 text-white" strokeWidth={1.4} />
        <div><p className="font-medium text-white">Tu tour 3D está disponible.</p><p className="mt-2 max-w-md text-sm text-white/65">Carga las estancias para recorrerlas. Cada una puede tardar unos segundos y consumir datos móviles.</p></div>
        <Button onClick={() => setOpened(true)}>Abrir tour 3D</Button>
      </div> : <>
        <div ref={host} tabIndex={0} role="application" aria-label={`Estancia ${rooms[active]?.name ?? ''}. Arrastra o usa las flechas para mirar alrededor.`} className="absolute inset-0 outline-none" />
        <div ref={fade} className="pointer-events-none absolute inset-0 bg-black transition-opacity duration-[350ms]" style={{ opacity: 1 }} />
        {status === 'loading' ? <div role="status" className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-lg bg-black/80 px-3 py-2 text-sm text-white"><LoaderCircle className="size-4 animate-spin" />Cargando {rooms[active]?.name}…</div> : null}
        {status === 'error' ? <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/90 p-6 text-center text-white">
          <p className="max-w-md text-sm">No se ha podido abrir esta estancia. Revisa tu sesión y que tu navegador tenga la aceleración gráfica habilitada.</p>
          <Button variant="secondary" onClick={() => { setStatus('loading'); setAttempt(value => value + 1); }}><RotateCcw />Reintentar</Button>
        </div> : null}
        <p className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-black/60 px-2 py-1 text-xs text-white/80">Recreación aproximada generada a partir de fotos</p>
      </>}
    </div>
    <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Estancias">
        {rooms.map((room, index) => <Button key={room.id} size="sm" variant={index === active ? 'default' : 'outline'} aria-pressed={index === active}
          disabled={!opened} onClick={() => select(index)}>{room.name}</Button>)}
      </div>
      <Button variant="ghost" size="icon" aria-label="Ver tour a pantalla completa" disabled={!opened}
        onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void frame.current?.requestFullscreen().catch(() => {}); }}><Expand /></Button>
    </div>
  </div>;
}
