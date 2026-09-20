'use client';
import { useState, useRef, useEffect } from 'react';
import Image from 'next/image';
import { ArrowLeft, ArrowRight, Expand, ImageIcon, LockKeyhole, Move, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SplatViewer } from '@/components/splat-viewer';
import type { TourView } from '@/lib/contracts';

export function TourViewer({ tour }: { tour: TourView | null }) {
  // Do not even mount the viewer document before payment. A watermark overlay
  // cannot protect a full model already sent to the browser.
  if (tour?.status === 'pagado' && !tour.simulated && tour.modelUrl) {
    return <SplatViewer key={tour.id} tourId={tour.id} />;
  }
  return <ImageTourViewer tour={tour} />;
}

function ImageTourViewer({ tour }: { tour: TourView | null }) {
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const images = tour?.images.filter(i => i.url) ?? [];
  const current = images[active];
  const paid = tour?.status === 'pagado';

  useEffect(() => { setActive(0); setZoom(false); }, [tour?.id]);
  useEffect(() => { setFailed(false); }, [current?.url]);
  function navigate(direction: number) {
    setActive(i => (i + direction + images.length) % images.length);
    setZoom(false);
    if (image.current) image.current.style.transform = '';
  }
  return <div ref={frame} className="overflow-hidden rounded-xl border border-border bg-background" onContextMenu={e => e.preventDefault()}>
    <div className="relative aspect-[4/3] overflow-hidden sm:aspect-[16/9] work-grid" tabIndex={images.length ? 0 : -1}
      role="region" aria-label="Visor de imágenes de la propiedad. Usa las flechas para navegar."
      onKeyDown={e => { if (images.length && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); navigate(e.key === 'ArrowRight' ? 1 : -1); } }}
      onPointerDown={e => { if (!zoom) return; drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onPointerMove={e => { if (zoom && drag.current && image.current) {
        const x = Math.max(-90, Math.min(90, e.clientX - drag.current.x));
        const y = Math.max(-70, Math.min(70, e.clientY - drag.current.y));
        image.current.style.transform = `translate(${x}px,${y}px) scale(1.5)`;
      } }} style={{ touchAction: zoom ? 'none' : 'pan-y' }}>
      {current?.url ? <>
        <div ref={image} className="absolute inset-0 transition-transform duration-150" style={{ transform: zoom ? 'scale(1.5)' : undefined }}>
          <Image key={current.url} src={current.url} alt={`Vista de la propiedad: ${current.name}`} fill unoptimized
            className="select-none object-contain" draggable={false} sizes="(max-width: 1100px) 100vw, 1000px" onError={() => setFailed(true)} />
        </div>
        {!paid ? <div className="pointer-events-none absolute inset-x-0 top-5 flex justify-center"><Badge className="border-white/20 bg-black/60 text-white"><LockKeyhole className="size-3" />VISTA PREVIA - Requiere Pago</Badge></div> : null}
        {failed ? <div role="alert" className="absolute inset-0 grid place-content-center bg-background/90 p-6 text-center text-sm">No se ha podido cargar esta imagen. Actualiza la página para reintentar.</div> : null}
        <div className="absolute bottom-4 left-4 rounded-lg bg-black/60 px-3 py-2 text-sm text-white">{String(active + 1).padStart(2, '0')} <span className="text-white/50">/ {String(images.length).padStart(2, '0')}</span></div>
        <div className="absolute bottom-4 right-4 flex gap-2">
          <Button variant="secondary" size="icon" aria-label={zoom ? 'Reducir imagen' : 'Ampliar imagen'} onClick={() => { setZoom(!zoom); if (image.current) image.current.style.transform = zoom ? '' : 'scale(1.5)'; }}>{zoom ? <ZoomOut /> : <ZoomIn />}</Button>
          <Button variant="secondary" size="icon" aria-label="Ver a pantalla completa" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void frame.current?.requestFullscreen().catch(() => {}); }}><Expand /></Button>
        </div>
      </> : <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl border border-border bg-card"><ImageIcon className="size-7 text-muted-foreground" strokeWidth={1.3} /></div>
        <div><p className="font-medium">Tu propiedad, desde otra perspectiva.</p><p className="mt-2 text-sm text-muted-foreground">La previsualización aparecerá aquí después de subir tus fotos.</p></div>
      </div>}
    </div>
    <div className="flex min-h-16 items-center justify-between gap-3 border-t border-border px-4">
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><Move className="size-4" />{zoom ? 'Arrastra para explorar la imagen' : images.length ? 'Explora las imágenes de tu propiedad' : 'Visor interactivo'}</p>
      <div className="flex shrink-0 gap-1"><Button variant="ghost" size="icon" disabled={images.length < 2} aria-label="Imagen anterior" onClick={() => navigate(-1)}><ArrowLeft /></Button><Button variant="ghost" size="icon" disabled={images.length < 2} aria-label="Imagen siguiente" onClick={() => navigate(1)}><ArrowRight /></Button></div>
    </div>
  </div>;
}
