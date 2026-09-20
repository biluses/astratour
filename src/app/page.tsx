import { auth } from '@/auth';
import { AstraFlow } from '@/components/astra-flow';
import { authConfigured, checkoutConfigured, reconstructionConfigured, minReconstructionImages } from '@/lib/config';
import { getSql } from '@/lib/db';
import { uuidSchema, type TourView, type TourRow } from '@/lib/contracts';
import { getOwnedTour, tourView } from '@/lib/tours';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const accessReady = authConfigured();
  const session = accessReady ? await auth() : null;
  let initialTour: TourView | null = null;
  let initialError: string | null = params.error ? 'No se pudo iniciar sesión. Vuelve a intentarlo con Google.' : null;

  if (session?.user?.id) {
    try {
      const tourId = typeof params.tour === 'string' ? params.tour : null;
      if (tourId && uuidSchema.safeParse(tourId).success) {
        initialTour = await tourView(await getOwnedTour(tourId, session.user.id));
      } else {
        const sql = getSql();
        const [latest] = await sql`SELECT * FROM tours WHERE user_id = ${session.user.id}
          ORDER BY created_at DESC LIMIT 1`;
        if (latest) initialTour = await tourView(latest as TourRow);
      }
    } catch {
      initialError = 'No se ha podido recuperar esta propiedad. Puedes volver a intentarlo.';
    }
  }

  return <AstraFlow
    user={session?.user?.id ? {
      id: session.user.id, name: session.user.name ?? 'Agente', image: session.user.image ?? null,
    } : null}
    initialTour={initialTour}
    initialError={initialError}
    accessReady={accessReady}
    paymentsReady={checkoutConfigured()}
    reconstructionReady={reconstructionConfigured()}
    minimumImages={minReconstructionImages()}
    checkoutReturn={params.checkout === 'success' ? 'success' : params.checkout === 'cancelled' ? 'cancelled' : null}
  />;
}
