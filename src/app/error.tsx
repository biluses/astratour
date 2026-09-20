'use client';
import { Button } from '@/components/ui/button';
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="mx-auto max-w-xl px-6 py-24"><h1 className="mb-4 text-3xl font-semibold">No hemos podido cargar tu espacio.</h1><p className="mb-8 text-muted-foreground">Vuelve a intentarlo. Un pago solo se confirma después de verificarlo con Stripe.</p><Button onClick={reset}>Volver a intentar</Button></main>;
}
