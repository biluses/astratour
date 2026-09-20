'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { signIn, signOut } from 'next-auth/react';
import { ArrowDown, ArrowRight, Check, CircleAlert, CreditCard, Download, ImagePlus, LoaderCircle,
  LockKeyhole, LogOut, Plus, RefreshCw, ShieldCheck, Sparkles, UploadCloud, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { createTourSchema, MAX_FILES, MAX_TOTAL_BYTES, type TourView } from '@/lib/contracts';
import { cn } from '@/lib/utils';

const TourViewer = dynamic(() => import('@/components/tour-viewer').then(m => m.TourViewer), {
  loading: () => <div className="aspect-video animate-pulse rounded-xl bg-secondary" aria-label="Cargando el visor" />,
});

interface Props {
  user: { id: string; name: string; image: string | null } | null;
  initialTour: TourView | null;
  initialError: string | null;
  accessReady: boolean;
  paymentsReady: boolean;
  reconstructionReady: boolean;
  minimumImages: number;
  checkoutReturn: 'success' | 'cancelled' | null;
}
type Job = { tourId: string; uploads: { imageId: string; pathname: string }[]; completed: Set<string> };
type Busy = 'upload' | 'process' | 'checkout' | 'signin' | null;

function reconstructionLabel(tour: TourView | null) {
  const stage = tour?.reconstruction?.stage;
  const labels: Record<string, string> = {
    queued: 'Captura en cola de reconstrucción…', download: 'Descargando y validando las fotos…',
    validation: 'Validando las fotografías…', export: 'Exportando el modelo 3D…', colmap: 'Calculando posiciones de cámara…', training: 'Reconstruyendo la escena 3D…',
    rendering: 'Generando renders de vista previa…', packaging: 'Preparando el modelo y el visor…',
    uploading: 'Guardando el tour de forma privada…', completed: 'Reconstrucción completada',
  };
  return labels[stage ?? ''] ?? 'Procesando la reconstrucción 3D…';
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'No se ha podido conectar. Vuelve a intentarlo.');
  return body as T;
}

function Step({ number, title, description, completed, active, right, children }: {
  number: number; title: string; description: string; completed?: boolean; active?: boolean;
  right?: ReactNode; children: ReactNode;
}) {
  return <Card className={cn('p-5 sm:p-7', active && 'border-primary/40')}>
    <div className="mb-6 flex items-start justify-between gap-3">
      <div className="flex items-start gap-3 sm:gap-4">
        <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium',
          completed ? 'border-success/25 bg-success/10 text-success' : active ? 'border-primary/30 bg-primary/10 text-primary' : 'text-muted-foreground')}>
          {completed ? <Check className="size-4" /> : `0${number}`}
        </span>
        <div><h2 className="text-lg font-semibold tracking-tight">{title}</h2><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p></div>
      </div>
      {right}
    </div>
    {children}
  </Card>;
}

export function AstraFlow({ user, initialTour, initialError, accessReady, paymentsReady, reconstructionReady, minimumImages, checkoutReturn }: Props) {
  const [tour, setTour] = useState(initialTour);
  const [files, setFiles] = useState<File[]>([]);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState<Busy>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [paymentWaiting, setPaymentWaiting] = useState(checkoutReturn === 'success');
  const [notice, setNotice] = useState(checkoutReturn === 'cancelled'
    ? 'El pago se ha cancelado. Tu previsualización sigue disponible.' : null);
  const input = useRef<HTMLInputElement>(null);
  const uploadSection = useRef<HTMLElement>(null);
  const previewSection = useRef<HTMLElement>(null);
  const job = useRef<Job | null>(null);
  const paid = tour?.status === 'pagado';
  const previewReady = tour?.status === 'pendiente_de_pago' || paid;
  const activeStep = !user ? 1 : !previewReady ? 2 : paid ? 4 : 3;
  const reconstructing = tour?.status === 'procesando';
  const isWorking = busy === 'upload' || busy === 'process' || reconstructing;
  const canSelect = Boolean(user) && !busy && !reconstructing && !job.current && !previewReady;

  useEffect(() => {
    const urls = files.map(f => URL.createObjectURL(f));
    setThumbnails(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [files]);

  useEffect(() => {
    if (user && !initialTour) uploadSection.current?.scrollIntoView({ block: 'center' });
  }, [user, initialTour]);

  const refreshTour = useCallback(async () => {
    if (!tour) return;
    const next = await api<TourView>(`/api/tours/${tour.id}`);
    setTour(next);
    if (next.status === 'pagado') { setPaymentWaiting(false); setNotice('Pago confirmado. Tu pack completo ya está disponible.'); }
  }, [tour]);

  useEffect(() => {
    if (!tour || paid || (!paymentWaiting && tour.status !== 'procesando')) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const id = tour.id;
    async function poll() {
      try {
        const next = await api<TourView>(`/api/tours/${id}`);
        if (cancelled) return;
        setTour(next);
        if (next.status === 'pagado') { setPaymentWaiting(false); setNotice('Pago confirmado. Tu pack completo ya está disponible.'); return; }
        if (!paymentWaiting && next.status !== 'procesando') return;
      } catch { /* Transient polling failures keep the preview available. Manual refresh remains available. */ }
      if (cancelled) return;
      if (++attempts >= (paymentWaiting ? 45 : 720)) {
        setPaymentWaiting(false);
        setNotice(paymentWaiting ? 'La confirmación está tardando. Actualiza el estado en unos instantes; no hace falta repetir el pago.' : 'La generación está tardando. Actualiza el estado; podrás reintentar si el proceso se ha interrumpido.');
        return;
      }
      timer = setTimeout(poll, paymentWaiting ? 2000 : 5000);
    }
    timer = setTimeout(poll, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tour?.id, tour?.status, paid, paymentWaiting]);

  function chooseFiles(incoming: File[]) {
    if (!canSelect) return;
    const next = [...files, ...incoming];
    if (!createTourSchema.safeParse({ files: next.map(f => ({ name: f.name, size: f.size, type: f.type })) }).success) {
      setError(`Selecciona hasta ${MAX_FILES} fotos JPG o PNG: 10 MB por imagen y ${Math.round(MAX_TOTAL_BYTES / 1024 ** 3)} GB en total.`);
      return;
    }
    setFiles(next); setError(null);
  }

  async function process(id: string) {
    setBusy('process');
    const next = await api<TourView>(`/api/tours/${id}/process`, { method: 'POST' });
    setTour(next); setFiles([]); job.current = null;
    previewSection.current?.scrollIntoView({ block: 'start' });
  }

  async function generate() {
    if (!user || busy || reconstructing || !reconstructionReady) return;
    if (files.length && files.length < minimumImages) { setError(`Para reconstruir una escena necesitas al menos ${minimumImages} fotos solapadas. La calidad depende de la captura.`); return; }
    setError(null); setNotice(null);
    try {
      if (files.length) {
        setBusy('upload');
        if (!job.current) {
          const created = await api<Omit<Job, 'completed'>>('/api/tours', { method: 'POST', body: JSON.stringify({
            title: title.trim() || 'Mi propiedad', files: files.map(f => ({ name: f.name, size: f.size, type: f.type })),
          }) });
          job.current = { ...created, completed: new Set() };
          setTour({ id: created.tourId, title: title.trim() || 'Mi propiedad', status: 'borrador', simulated: false, images: [], modelUrl: null });
          window.history.replaceState(null, '', `/?tour=${created.tourId}`);
        }
        const currentJob = job.current;
        const { upload } = await import('@vercel/blob/client');
        for (const [index, descriptor] of currentJob.uploads.entries()) {
          if (currentJob.completed.has(descriptor.imageId)) continue;
          try {
            await upload(descriptor.pathname, files[index], {
              access: 'private', handleUploadUrl: '/api/upload',
              clientPayload: JSON.stringify({ tourId: currentJob.tourId, imageId: descriptor.imageId }),
              onUploadProgress: ({ percentage }) => setProgress((index + percentage / 100) / files.length * 100),
            });
          } catch (uploadError) {
            // A network error may arrive after Blob persisted the file. Confirm exact
            // metadata server-side instead of overwriting or duplicating the upload.
            const reconciled = await api<{ uploaded: boolean }>(
              `/api/tours/${currentJob.tourId}/uploads/${descriptor.imageId}`, { method: 'POST' });
            if (!reconciled.uploaded) throw uploadError;
          }
          currentJob.completed.add(descriptor.imageId);
        }
        await process(currentJob.tourId);
      } else if (tour) await process(tour.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se ha podido generar la vista previa.');
      if (job.current) {
        try { setTour(await api<TourView>(`/api/tours/${job.current.tourId}`)); } catch { /* Preserve the current retry context. */ }
      }
    } finally { setBusy(null); }
  }

  async function checkout() {
    if (!tour || busy || paid) return;
    setError(null); setBusy('checkout');
    try {
      const { url } = await api<{ url: string }>('/api/checkout', { method: 'POST', body: JSON.stringify({ tourId: tour.id }) });
      const destination = new URL(url);
      if (destination.protocol !== 'https:' || destination.hostname !== 'checkout.stripe.com') throw new Error('Destino de pago no válido.');
      window.location.assign(url);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se ha podido abrir Stripe.'); setBusy(null); }
  }

  function startNew() {
    if (busy) return;
    setTour(null); setFiles([]); setTitle(''); setError(null); setNotice(null); setPaymentWaiting(false); setProgress(0);
    job.current = null;
    window.history.replaceState(null, '', '/');
    uploadSection.current?.scrollIntoView({ block: 'center' });
  }

  return <>
    <a href="#workspace" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:p-3 focus:text-primary-foreground">Ir a crear mi tour</a>
    <header className="border-b border-border/70">
      <div className="mx-auto flex h-20 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
        <a href="/" aria-label="AstraTour Express, inicio" className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Sparkles className="size-5" strokeWidth={1.6} /></span>
          <span className="text-xl font-semibold tracking-tight">AstraTour <span className="ml-1 hidden font-mono text-[11px] font-normal tracking-widest text-primary sm:inline">EXPRESS</span></span>
        </a>
        <div className="flex items-center gap-3 sm:gap-5"><span className="text-sm text-muted-foreground"><span className="font-medium text-foreground">19 €</span> / tour</span>
          {user ? <Button variant="ghost" size="icon" aria-label="Cerrar sesión" onClick={() => void signOut({ redirectTo: '/' })}><LogOut /></Button> : <Badge className="hidden sm:inline-flex">Pago único</Badge>}
        </div>
      </div>
    </header>

    <main id="workspace" className="mx-auto max-w-5xl px-5 pb-14 pt-12 sm:px-8 sm:pt-16">
      <div className="mb-10 flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div><div className="mb-5 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-primary"><span className="h-px w-5 bg-primary" />Un nuevo ángulo para tu propiedad</div>
          <h1 className="max-w-2xl text-[2.6rem] font-medium leading-[1.1] tracking-[-0.045em] sm:text-6xl">Tus fotos.<br /><span className="text-muted-foreground">La próxima visita.</span></h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground">Sube tus imágenes, explora la previsualización y desbloquea tu pack. Todo, en un mismo lugar.</p>
        </div>
        <span className="flex items-center gap-2 text-sm text-muted-foreground"><ArrowDown className="size-4 text-primary" />Cuatro pasos. Sin suscripciones.</span>
      </div>

      <nav aria-label="Progreso de creación" className="mb-7 grid grid-cols-4 overflow-hidden rounded-xl border border-border bg-card">
        {['Conecta', 'Sube', 'Explora', 'Descarga'].map((label, i) => <a key={label} href={`#step-${i + 1}`} aria-current={activeStep === i + 1 ? 'step' : undefined}
          className={cn('flex items-center justify-center gap-2 border-r border-border py-4 text-xs transition-colors last:border-r-0 hover:bg-secondary sm:text-sm', activeStep === i + 1 ? 'bg-primary/8 text-primary' : 'text-muted-foreground')}>
          <span className="hidden font-mono text-xs sm:inline">0{i + 1}</span>{label}
        </a>)}
      </nav>

      {error ? <div role="alert" className="mb-5 flex items-start justify-between gap-3 rounded-xl border border-red-400/30 bg-red-400/8 p-4 text-sm leading-relaxed text-red-200"><div className="flex gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" />{error}</div><Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label="Cerrar aviso" onClick={() => setError(null)}><X /></Button></div> : null}
      {notice ? <p role="status" className="mb-5 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-relaxed">{notice}</p> : null}

      <div className="space-y-5">
        <section id="step-1" aria-label="Paso 1: Registro">
          <Step number={1} title="Conecta tu cuenta" description="Tu espacio empieza con un solo clic." completed={Boolean(user)} active={!user}
            right={user ? <Badge className="hidden border-success/20 text-success sm:flex">Conectado</Badge> : <Badge className="hidden sm:flex">Sin contraseña</Badge>}>
            {user ? <div className="flex flex-wrap items-center justify-between gap-4 sm:pl-12"><div className="flex items-center gap-3"><Avatar><AvatarImage src={user.image ?? undefined} alt={user.name} /><AvatarFallback>{user.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar><div><p className="text-sm font-medium">{user.name}</p><p className="mt-0.5 text-xs text-muted-foreground">Sesión guardada. Ya puedes subir tus fotos.</p></div></div>
              {tour ? <Button variant="outline" size="sm" onClick={startNew} disabled={Boolean(busy)}><Plus />Nueva propiedad</Button> : null}</div>
              : <div className="flex flex-wrap items-center gap-4 sm:pl-12"><Button size="lg" variant="outline" className="bg-foreground text-background hover:bg-white/90" disabled={!accessReady || Boolean(busy)}
                onClick={async () => { setBusy('signin'); try { await signIn('google', { redirectTo: '/#step-2' }); } catch { setError('No se pudo conectar con Google. Vuelve a intentarlo.'); setBusy(null); } }}>
                {busy === 'signin' ? <LoaderCircle className="animate-spin" /> : <span aria-hidden="true" className="text-lg font-bold text-blue-600">G</span>}Continuar con Google</Button>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><LockKeyhole className="size-3.5" />{accessReady ? 'Tu cuenta y tus fotos, protegidas.' : 'El registro estará disponible al configurar el servicio.'}</p></div>}
          </Step>
        </section>

        <section id="step-2" ref={uploadSection} aria-label="Paso 2: Imágenes">
          <Step number={2} title="Dale vida a tus imágenes" description="Captura una única propiedad desde distintas posiciones y con solapamiento." active={Boolean(user) && !previewReady} completed={Boolean(previewReady)}
            right={<Badge className="shrink-0">{files.length || tour?.images.length || 0} / {MAX_FILES} fotos</Badge>}>
            {!reconstructionReady ? <p role="status" className="mb-5 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">El servidor de reconstrucción todavía no está activado. Puedes conectar tu cuenta; la generación permanecerá deshabilitada hasta que el motor esté operativo.</p> : null}
            {tour?.status === 'error' ? <p role="alert" className="mb-5 rounded-lg border border-red-400/30 p-4 text-sm">No se pudo completar la reconstrucción. Revisa el solapamiento y la nitidez de las fotos antes de volver a intentarlo. No se ha realizado ningún cargo.</p> : null}
            {!previewReady ? <>
              <label htmlFor="property-title" className="mb-2 block text-sm text-muted-foreground">Nombre de la propiedad <span className="text-xs">(opcional)</span></label>
              <input id="property-title" value={title} onChange={e => setTitle(e.target.value)} disabled={!canSelect} maxLength={120}
                placeholder="Ej. Ático en Chamberí" className="mb-5 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm placeholder:text-muted-foreground/60 disabled:opacity-50" />
              <input ref={input} type="file" multiple accept="image/jpeg,image/png" disabled={!canSelect} className="sr-only" tabIndex={-1} aria-label="Seleccionar imágenes JPG o PNG" onChange={e => { chooseFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
              <div role="button" aria-label="Arrastra imágenes o pulsa para seleccionarlas" aria-disabled={!canSelect} tabIndex={canSelect ? 0 : -1}
                onClick={() => canSelect && input.current?.click()}
                onKeyDown={e => { if (canSelect && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.current?.click(); } }}
                onDragOver={e => { e.preventDefault(); if (canSelect) setDragging(true); }} onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); chooseFiles(Array.from(e.dataTransfer.files)); }}
                className={cn('flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background p-6 text-center transition-colors', dragging && 'border-primary bg-primary/10', !user && 'opacity-55', canSelect && 'hover:border-primary/60 hover:bg-primary/3')}>
                <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-secondary text-primary">{user ? <UploadCloud className="size-6" strokeWidth={1.5} /> : <LockKeyhole className="size-5" />}</div>
                <p className="text-base font-medium">{user ? 'Arrastra tus fotos aquí' : 'Conecta tu cuenta para subir fotos'}</p>
                <p className="mt-1.5 text-sm text-muted-foreground">{user ? <>o <span className="text-primary underline decoration-primary/40 underline-offset-4">selecciona archivos</span> desde tu dispositivo</> : 'Después podrás elegir las imágenes de tu propiedad.'}</p>
                <p className="mt-4 font-mono text-xs text-muted-foreground">JPG / PNG · 10 MB por foto · 2 GB en total</p>
              </div>
              {files.length ? <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">{files.slice(0, 60).map((file, i) => <div key={`${file.name}-${i}`} className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-background">
                {thumbnails[i] ? <Image src={thumbnails[i]} alt={file.name} fill unoptimized className="object-cover" sizes="150px" /> : null}
                {!job.current ? <Button variant="secondary" size="icon" className="absolute right-1 top-1 size-7 bg-black/70" aria-label={`Quitar ${file.name}`} disabled={Boolean(busy)} onClick={() => setFiles(v => v.filter((_, index) => index !== i))}><X className="size-3" /></Button> : null}
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-2 py-1 text-xs">{file.name}</span>
              </div>)}</div> : null}
              {files.length > 60 ? <p className="mt-3 text-xs text-muted-foreground">Mostrando las primeras 60 miniaturas de {files.length} fotos seleccionadas.</p> : null}
              <div className="mt-5 flex flex-wrap items-center justify-between gap-4"><p className="text-xs text-muted-foreground">Al menos {minimumImages} fotos. Solapamiento del 70–80 %, buena luz y sin objetos en movimiento.</p>
                <Button onClick={() => void generate()} disabled={!user || isWorking || Boolean(busy) || !reconstructionReady || (files.length ? files.length < minimumImages : !tour)}>
                  {isWorking ? <LoaderCircle className="animate-spin" /> : <Sparkles />}{isWorking ? 'Procesando…' : tour && !files.length ? 'Reintentar generación' : 'Generar previsualización'}{!isWorking ? <ArrowRight /> : null}
                </Button></div>
            </> : <div className="flex items-center justify-between gap-4 rounded-xl bg-background px-4 py-4"><div className="flex items-center gap-3"><ImagePlus className="size-5 text-primary" /><div><p className="text-sm font-medium">{tour?.title}</p><p className="mt-1 text-xs text-muted-foreground">{tour?.images.length} imágenes procesadas y guardadas</p></div></div><Check className="size-5 text-success" /></div>}
            {isWorking ? <div className="mt-5 rounded-xl border border-primary/20 bg-primary/5 p-5" role="status" aria-live="polite">
              <div className="flex items-center justify-between gap-2 text-sm"><p className="flex items-center gap-2"><Sparkles className="size-4 text-primary" />{busy === 'upload' ? 'Subiendo tus imágenes…' : reconstructionLabel(tour)}</p><span className="font-mono text-xs">{Math.round(busy === 'upload' ? progress : tour?.reconstruction?.progress ?? 0)}%</span></div>
              <div className="mt-4 h-1 overflow-hidden rounded-full bg-secondary">{busy === 'upload' ? <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /> : <div className="loading-bar h-full w-1/3 bg-primary" />}</div>
              <p className="mt-3 text-xs text-muted-foreground">{busy === 'upload' ? 'Mantén esta ventana abierta hasta completar la carga.' : 'Reconstrucción real en un servidor GPU. Puedes cerrar esta página y recuperar el estado al volver.'}</p>
            </div> : null}
          </Step>
        </section>

        <section id="step-3" ref={previewSection} aria-label="Paso 3: Previsualización">
          <Step number={3} title="Explora antes de desbloquear" description="Revisa los renders de la reconstrucción antes de desbloquear el modelo." active={Boolean(previewReady) && !paid} completed={Boolean(paid)}
            right={<Badge className="hidden sm:flex">{paid ? 'Sin marca de agua' : 'Vista previa'}</Badge>}>
            <TourViewer tour={tour} />
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{tour?.simulated ? 'Este tour pertenece al prototipo anterior: contiene fotografías, no un modelo 3D.' : 'Antes del pago solo se muestran renders reducidos con marca de agua incorporada. El modelo 3D completo permanece privado.'}</p>
          </Step>
        </section>

        <section id="step-4" aria-label="Paso 4: Pago y descarga">
          <Step number={4} title={paid ? 'Tu pack está listo' : 'Una propiedad. Un solo pago.'} description={paid ? 'Descárgalo y ábrelo en tu navegador.' : 'Desbloquea el modelo 3D y el visor SuperSplat descargable.'} active={Boolean(previewReady)} completed={Boolean(paid)}
            right={<div className="text-right"><span className="text-3xl font-medium tracking-tight">19<span className="ml-1 text-lg text-muted-foreground">€</span></span><p className="mt-1 text-xs text-muted-foreground">pago único</p></div>}>
            <div className="mb-6 flex flex-wrap gap-x-6 gap-y-3 text-sm text-muted-foreground">{['Modelo 3D privado', 'Visor SuperSplat', 'Pack descargable'].map(t => <span key={t} className="flex items-center gap-2"><Check className="size-4 text-primary" />{t}</span>)}</div>
            {paid && tour ? <Button asChild size="lg" className="w-full"><a href={`/api/tours/${tour.id}/download`}><Download />Descargar Pack Completo</a></Button> : <Button size="lg" className="w-full text-wrap leading-relaxed" disabled={!previewReady || Boolean(busy) || !paymentsReady || paymentWaiting} onClick={() => void checkout()}>
              {busy === 'checkout' || paymentWaiting ? <LoaderCircle className="animate-spin" /> : <CreditCard />}
              {paymentWaiting ? 'Verificando el pago con Stripe…' : busy === 'checkout' ? 'Abriendo Stripe Checkout…' : 'Descargar Tour 3D en Alta Resolución - 19€'}
            </Button>}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="size-3.5" />Stripe Checkout · Pago seguro</p>
              {tour ? <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => { setError(null); void refreshTour().catch(e => setError(e.message)); }}><RefreshCw />Actualizar estado</Button> : <span className="text-xs text-muted-foreground">Completa los pasos anteriores</span>}
            </div>
            <p className="mt-3 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">Modo de prueba: no se realizan cargos reales. La reconstrucción debe completarse antes de pagar. Las fotos de un anuncio sin suficiente solapamiento no garantizan un tour válido.</p>
          </Step>
        </section>
      </div>
      <footer className="mt-9 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>AstraTour Express</span><span>De la primera foto a la próxima visita.</span></footer>
    </main>
  </>;
}
