import type { Raw } from './html.ts';
import { raw } from './html.ts';

export interface AppPage {
  slug: string;
  name: string;
  line: string;
  summary: string;
  features: string[];
  requirements: string[];
  icon: Raw;
}

const GAUGE = raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
  <path d="M4 17a8 8 0 1 1 16 0"/>
  <path d="M12 17l4-5"/>
  <circle cx="12" cy="17" r="1.6" fill="currentColor"/>
</svg>`);

export const APP_PAGES: AppPage[] = [
  {
    slug: 'jeep-obd2',
    name: 'Jeep OBD2',
    line: 'Lee y borra los códigos de falla de tu vehículo desde el teléfono.',
    summary:
      'Jeep OBD2 se conecta a un adaptador ELM327 por Bluetooth, lee los códigos de falla del vehículo con su descripción en español, los borra cuando ya hiciste la reparación y te muestra lecturas en vivo. Se probó con un Jeep Wrangler TJ 1998.',
    features: [
      'Lee los códigos guardados y pendientes, con su descripción en español.',
      'Borra los códigos, siempre con confirmación.',
      'Lecturas en vivo: voltaje de batería, temperatura del motor, RPM, velocidad y más.',
      'Guarda varios vehículos y lee el número VIN cuando el vehículo lo entrega.',
      'Busca videos de reparación en YouTube para cada código, con tus propias llaves de Anthropic y YouTube.',
    ],
    requirements: [
      'Android 7 o más reciente.',
      'Un adaptador ELM327 Bluetooth, clásico o BLE.',
      'Una cuenta de Google para entrar.',
    ],
    icon: GAUGE,
  },
];

export function appPage(slug: string): AppPage | undefined {
  return APP_PAGES.find((a) => a.slug === slug);
}
