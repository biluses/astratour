import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Check, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { MAX_FILE_BYTES, MIN_CAPTURE_FILES, RECOMMENDED_CAPTURE_FILES } from '@/lib/contracts';
import { MIN_SHORT_SIDE_PX } from '@/lib/capture-checks';

export const metadata: Metadata = {
  title: 'Guía de captura · AstraTour Express',
  description: `Cómo fotografiar una estancia para reconstruirla en 3D: mínimo ${MIN_CAPTURE_FILES} fotos, giros de 20° como máximo, recorrido por el perímetro y desde el centro.`,
};

const MAX_MB = MAX_FILE_BYTES / 1024 ** 2;

/** Point at `r` from (cx, cy) in direction `deg`, where 0° points up and angles grow clockwise. */
function polar(cx: number, cy: number, deg: number, r: number) {
  const a = deg * Math.PI / 180;
  return { x: +(cx + r * Math.sin(a)).toFixed(1), y: +(cy - r * Math.cos(a)).toFixed(1) };
}

function Arrow({ x, y, deg, length = 22 }: { x: number; y: number; deg: number; length?: number }) {
  const end = polar(x, y, deg, length);
  return <g>
    <circle cx={x} cy={y} r={4} className="fill-primary" />
    <line x1={x} y1={y} x2={end.x} y2={end.y} stroke="currentColor" strokeWidth={1.6} markerEnd="url(#arrowhead)" className="text-primary" />
  </g>;
}

function RoomPattern() {
  // Perimeter positions face inward (0° = up); centre positions face outward.
  const perimeter = [
    ...[80, 150, 220, 290, 360].map(x => ({ x, y: 48, deg: 180 })),
    ...[80, 150, 220, 290, 360].map(x => ({ x, y: 252, deg: 0 })),
    ...[105, 150, 195].map(y => ({ x: 48, y, deg: 90 })),
    ...[105, 150, 195].map(y => ({ x: 392, y, deg: 270 })),
  ];
  const centre = Array.from({ length: 8 }, (_, i) => ({ ...polar(220, 150, i * 45, 16), deg: i * 45 }));
  return <svg viewBox="0 0 440 300" role="img" aria-labelledby="room-title room-desc" className="h-auto w-full text-muted-foreground">
    <title id="room-title">Recorrido de captura visto desde arriba</title>
    <desc id="room-desc">Planta de una estancia rectangular. Dieciséis posiciones a lo largo de las paredes apuntan hacia el interior y ocho posiciones repartidas en un círculo alrededor del centro apuntan hacia fuera. Entre posiciones hay unos 50 centímetros.</desc>
    <defs><marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" className="fill-primary" /></marker></defs>
    <rect x={20} y={20} width={400} height={260} rx={6} fill="none" stroke="currentColor" strokeWidth={2} />
    <rect x={185} y={20} width={70} height={6} className="fill-muted-foreground/40" />
    {perimeter.map(p => <Arrow key={`${p.x}-${p.y}`} {...p} />)}
    {centre.map(p => <Arrow key={p.deg} {...p} length={18} />)}
    <text x={220} y={196} textAnchor="middle" fontSize={12} fill="currentColor">centro: mirando hacia fuera</text>
    <text x={220} y={104} textAnchor="middle" fontSize={12} fill="currentColor">perímetro: mirando hacia dentro</text>
  </svg>;
}

function OverlapDiagram() {
  const cx = 160, cy = 210, r = 170, halfFov = 31.5;
  const wedge = (dir: number) => {
    const a = polar(cx, cy, dir - halfFov, r), b = polar(cx, cy, dir + halfFov, r);
    return `M${cx} ${cy} L${a.x} ${a.y} A${r} ${r} 0 0 1 ${b.x} ${b.y} Z`;
  };
  const arcStart = polar(cx, cy, -10, 60), arcEnd = polar(cx, cy, 10, 60);
  return <svg viewBox="0 0 320 240" role="img" aria-labelledby="overlap-title overlap-desc" className="h-auto w-full text-muted-foreground">
    <title id="overlap-title">Giro máximo entre dos fotos consecutivas</title>
    <desc id="overlap-desc">Dos campos de visión de unos 63 grados desde el mismo punto, girados 20 grados entre sí. Comparten alrededor del 70 por ciento de la imagen.</desc>
    <path d={wedge(-10)} className="fill-primary/15" stroke="currentColor" strokeWidth={1.2} />
    <path d={wedge(10)} className="fill-primary/15" stroke="currentColor" strokeWidth={1.2} strokeDasharray="4 3" />
    <path d={`M${arcStart.x} ${arcStart.y} A60 60 0 0 1 ${arcEnd.x} ${arcEnd.y}`} fill="none" stroke="currentColor" strokeWidth={2} className="text-primary" />
    <circle cx={cx} cy={cy} r={5} className="fill-primary" />
    <text x={cx} y={cy - 70} textAnchor="middle" fontSize={13} className="fill-primary">≤ 20°</text>
    <text x={cx} y={34} textAnchor="middle" fontSize={13} fill="currentColor">~70 % de solapamiento</text>
    <text x={cx} y={232} textAnchor="middle" fontSize={11} fill="currentColor">foto 1 (continua) · foto 2 (discontinua)</text>
  </svg>;
}

const checklist = [
  `Tengo al menos ${MIN_CAPTURE_FILES} fotos de la estancia (mejor ${RECOMMENDED_CAPTURE_FILES}–80).`,
  'Todas son de la misma cámara y lente, sin zoom y en la misma orientación.',
  'Cada zona aparece en al menos 3 fotos y ningún giro entre fotos seguidas supera unos 20°.',
  'He recorrido el perímetro mirando hacia dentro y alrededor del centro mirando hacia fuera, a dos alturas.',
  'La luz no ha cambiado y no había personas ni mascotas moviéndose.',
  'Las fotos están nítidas, sin recortes ni retoques, y no están duplicadas.',
  `Son archivos JPG o PNG de ${MAX_MB} MB como máximo cada uno.`,
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card className="p-5 sm:p-7">
    <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
    <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
  </Card>;
}

export default function CaptureGuidePage() {
  return <>
    <header className="border-b border-border/70">
      <div className="mx-auto flex h-20 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
        <Link href="/" aria-label="AstraTour Express, inicio" className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Sparkles className="size-5" strokeWidth={1.6} /></span>
          <span className="text-xl font-semibold tracking-tight">AstraTour</span>
        </Link>
        <Link href="/#step-2" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Volver a subir fotos</Link>
      </div>
    </header>

    <main className="mx-auto max-w-3xl px-5 pb-14 pt-12 sm:px-8 sm:pt-16">
      <div className="mb-5 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-primary"><span className="h-px w-5 bg-primary" />Guía de captura</div>
      <h1 className="text-[2.2rem] font-medium leading-[1.1] tracking-[-0.04em] sm:text-5xl">Cómo fotografiar una estancia para verla en 3D</h1>
      <p className="mt-5 text-base leading-relaxed text-muted-foreground">Unos minutos de método evitan repetir la captura. Estas son las reglas para que la reconstrucción funcione; algunas las comprobamos automáticamente al elegir las fotos.</p>

      <div className="mt-10 space-y-5">
        <Section title="Por qué importa cómo haces las fotos">
          <p>El sistema reconstruye la estancia en 3D buscando los mismos puntos en fotos que se solapan y calculando desde dónde se hizo cada una. Si una zona sale en pocas fotos, o si dos fotos seguidas apenas comparten contenido, esas fotos quedan desconectadas y la zona desaparece del modelo.</p>
        </Section>

        <Section title="Cuántas fotos">
          <ul className="list-disc space-y-1 pl-5">
            <li><strong className="text-foreground">Mínimo {MIN_CAPTURE_FILES} fotos:</strong> por debajo no se puede generar.</li>
            <li><strong className="text-foreground">Recomendado: {RECOMMENDED_CAPTURE_FILES}–80 por estancia.</strong> En una prueba con una estancia de referencia, con menos de 30 fotos se conectaba menos de la mitad de la escena; con 60 o más, en torno al 95 % o más.</li>
            <li>Con unas 90–100 fotos la calidad deja de mejorar de forma apreciable; por encima solo alarga el proceso.</li>
            <li>Las estancias grandes, en forma de L o con muchos rincones necesitan más. Si el tour incluye varias estancias conectadas, calcula 60–80 por estancia y fotografía también los pasos entre ellas (puertas y pasillos): en una casa de referencia con varias estancias hicieron falta unas 90 fotos para conectarlo todo.</li>
          </ul>
        </Section>

        <Section title="La regla del paso: giros pequeños y mucho solapamiento">
          <div className="mx-auto max-w-sm"><OverlapDiagram /></div>
          <ul className="list-disc space-y-1 pl-5">
            <li>Entre dos fotos seguidas, gira <strong className="text-foreground">como máximo unos 20°</strong>: aproximadamente un tercio del encuadre.</li>
            <li>Así cada foto comparte alrededor del <strong className="text-foreground">70 %</strong> de su contenido con la anterior.</li>
            <li>Cada zona de la estancia debe aparecer en <strong className="text-foreground">al menos 3 fotos</strong>.</li>
          </ul>
        </Section>

        <Section title="El recorrido">
          <div className="mx-auto max-w-md"><RoomPattern /></div>
          <ul className="list-disc space-y-1 pl-5">
            <li>Recorre el <strong className="text-foreground">perímetro</strong> de la estancia mirando hacia dentro.</li>
            <li>Después, <strong className="text-foreground">alrededor del centro</strong>, fotografía hacia fuera todas las paredes, dando un paso entre foto y foto.</li>
            <li>Haz las fotos a <strong className="text-foreground">dos alturas</strong>: a la altura del pecho y otra más baja o más alta.</li>
            <li>Muévete <strong className="text-foreground">medio metro</strong> entre posiciones.</li>
            <li>No te quedes en un punto girando sobre ti mismo: sin desplazamiento no hay paralaje y el sistema no puede calcular la profundidad.</li>
          </ul>
        </Section>

        <Section title="Luz y movimiento">
          <ul className="list-disc space-y-1 pl-5">
            <li>Mantén la luz constante durante toda la captura: no enciendas ni apagues lámparas a mitad.</li>
            <li>Que no haya personas ni mascotas moviéndose.</li>
            <li>Evita encuadres dominados por espejos o ventanas.</li>
            <li>Sujeta el móvil con firmeza y espera a que enfoque para que las fotos no salgan movidas.</li>
          </ul>
        </Section>

        <Section title="Cámara">
          <ul className="list-disc space-y-1 pl-5">
            <li>Usa siempre la misma cámara y la misma lente del móvil, sin zoom.</li>
            <li>No mezcles fotos verticales y horizontales.</li>
            <li>Dispara a la resolución máxima (al menos {MIN_SHORT_SIDE_PX} px en el lado corto).</li>
            <li>Formato JPG o PNG, {MAX_MB} MB como máximo por foto, sin recortes ni retoques.</li>
          </ul>
        </Section>

        <Section title="Antes de subir">
          <ul className="space-y-2">{checklist.map(item => <li key={item} className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0 text-primary" />{item}</li>)}</ul>
        </Section>
      </div>

      <Link href="/#step-2" className="mt-8 inline-flex items-center gap-2 text-sm text-primary underline decoration-primary/40 underline-offset-4"><ArrowLeft className="size-4" />Volver a subir fotos</Link>
    </main>
  </>;
}
