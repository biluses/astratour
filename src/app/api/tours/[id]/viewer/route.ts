import { renderViewerHtml } from '@playcanvas/supersplat-viewer';
import { defaultSettings, validateSettings } from '@playcanvas/supersplat-viewer/settings';
import { apiError, HttpError, requireUser } from '@/lib/http';
import { getOwnedTour } from '@/lib/tours';

export const runtime = 'nodejs';

// Trusted static code only. Never interpolate property names, uploaded HTML, or
// error messages into this document. The parent verifies origin AND source.
const statusBridge = `<script>
(() => {
  const report = (state) => parent.postMessage({ type: 'astratour-viewer', state }, location.origin);
  window.firstFrame = () => report('ready');
  addEventListener('error', () => report('error'));
  addEventListener('unhandledrejection', () => report('error'));
})();
</script>`;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const tour = await getOwnedTour(id, user.id);
    if (tour.status !== 'pagado') throw new HttpError(402, 'Completa el pago antes de abrir el modelo 3D.');
    if (tour.simulated || !tour.model_path || !tour.viewer_settings) {
      throw new HttpError(409, 'Esta propiedad no tiene una reconstrucción 3D disponible.');
    }

    // SuperSplat URL parameters override its bootstrap. Do not allow a caller to
    // repoint a same-origin authenticated document at arbitrary remote assets.
    const url = new URL(request.url);
    for (const [key, value] of url.searchParams) {
      if (!((key === 'lang' && value === 'es') || (key === 'webgl' && value === ''))) {
        throw new HttpError(400, 'Opción del visor no permitida.');
      }
    }
    const settings = defaultSettings();
    // The completion endpoint stores only a bounded numeric camera pose. A new
    // settings object prevents user-supplied URLs, annotations or HTML reaching
    // the viewer even if extra fields are ever added to the database value.
    settings.cameras = [{ initial: {
      position: tour.viewer_settings.position,
      target: tour.viewer_settings.target,
      fov: tour.viewer_settings.fov,
    } }];
    validateSettings(settings, { limits: true });
    const document = renderViewerHtml({
      bootstrap: {
        settings,
        contentUrl: `/api/tours/${id}/model.sog`,
        contentFilename: 'scene.sog',
      },
      baseHref: '/viewer/1.31.2/',
      backgroundColor: [0, 0, 0],
      inlineCss: true,
      bodyStartExtras: statusBridge,
    });
    return new Response(document, { headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Vary': 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), xr-spatial-tracking=()',
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' data: blob:; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:; base-uri 'self'; frame-ancestors 'self'; form-action 'none'",
    } });
  } catch (error) { return apiError(error); }
}
