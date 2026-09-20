'use client';

import { useEffect, useRef, useState } from 'react';
import { Box, Expand, LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function SplatViewer({ tourId }: { tourId: string }) {
  const [opened, setOpened] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [webgl, setWebgl] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'slow'>('loading');
  const iframe = useRef<HTMLIFrameElement>(null);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!opened) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframe.current?.contentWindow) return;
      if (event.data?.type !== 'astratour-viewer') return;
      if (event.data.state === 'ready' || event.data.state === 'error') setStatus(event.data.state);
    };
    window.addEventListener('message', onMessage);
    const timer = window.setTimeout(() => setStatus(current => current === 'loading' ? 'slow' : current), 90_000);
    return () => { window.removeEventListener('message', onMessage); window.clearTimeout(timer); };
  }, [opened, attempt]);

  function retry(compatibility: boolean) {
    setWebgl(compatibility);
    setStatus('loading');
    setAttempt(value => value + 1);
  }

  return <div ref={frame} className="overflow-hidden rounded-xl border border-border bg-background">
    <div className="relative aspect-[4/3] min-h-80 overflow-hidden bg-black sm:aspect-[16/9]">
      {!opened ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <Box className="size-10 text-white" strokeWidth={1.4} />
        <div><p className="font-medium text-white">Tu tour 3D está disponible.</p><p className="mt-2 max-w-md text-sm text-white/65">Carga el modelo para recorrerlo. Las escenas grandes pueden tardar unos segundos y consumir datos móviles.</p></div>
        <Button onClick={() => setOpened(true)}>Abrir tour 3D</Button>
      </div> : <>
        <iframe key={`${tourId}-${attempt}`} ref={iframe}
          src={`/api/tours/${tourId}/viewer?lang=es${webgl ? '&webgl' : ''}`}
          title="Tour 3D interactivo de la propiedad" loading="lazy"
          className="absolute inset-0 size-full border-0" allow="fullscreen" allowFullScreen
          referrerPolicy="no-referrer"
          onLoad={() => {
            // An authentication/authorization JSON response loads in an iframe
            // successfully but is not a working viewer.
            try {
              if (iframe.current?.contentDocument?.contentType !== 'text/html') setStatus('error');
            } catch { setStatus('error'); }
          }} />
        {status === 'loading' ? <div role="status" className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-lg bg-black/80 px-3 py-2 text-sm text-white"><LoaderCircle className="size-4 animate-spin" />Cargando modelo 3D…</div> : null}
        {status === 'error' || status === 'slow' ? <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/90 p-6 text-center text-white">
          <p className="max-w-md text-sm">{status === 'slow' ? 'El modelo tarda más de lo habitual. Revisa la conexión o prueba el modo compatible.' : 'No se ha podido abrir el modelo. Revisa tu sesión y que tu navegador tenga la aceleración gráfica habilitada.'}</p>
          <div className="flex flex-wrap justify-center gap-2"><Button variant="secondary" onClick={() => retry(webgl)}><RotateCcw />Reintentar</Button><Button variant="secondary" onClick={() => retry(true)}>Modo compatible</Button></div>
        </div> : null}
      </>}
    </div>
    <div className="flex min-h-16 items-center justify-between gap-3 border-t border-border px-4">
      <p className="text-xs text-muted-foreground">Arrastra para mirar. Usa los controles del visor para navegar y ajustar la calidad.</p>
      <Button variant="ghost" size="icon" aria-label="Ver tour a pantalla completa" disabled={!opened}
        onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void frame.current?.requestFullscreen().catch(() => {}); }}><Expand /></Button>
    </div>
  </div>;
}
