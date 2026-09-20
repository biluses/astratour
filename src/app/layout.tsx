import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AstraTour Express · De tus fotos a una nueva perspectiva',
  description: 'Reconstruye una propiedad con fotografías solapadas, revisa sus renders y descarga el tour 3D. Registro con Google y pago único.',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es" className="dark"><body className="antialiased">{children}</body></html>;
}
