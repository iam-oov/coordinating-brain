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
    line: "Reads and clears your vehicle's trouble codes from your phone.",
    summary:
      "Jeep OBD2 connects to an ELM327 Bluetooth adapter, reads your vehicle's trouble codes with a description, clears them once the repair is done and shows live readings. Tested with a 1998 Jeep Wrangler TJ.",
    features: [
      'Reads stored and pending trouble codes, with a description of each one.',
      'Clears the codes, always after asking you to confirm.',
      'Live readings: battery voltage, engine temperature, RPM, speed and more.',
      "Keeps several vehicles and reads the VIN when the vehicle provides it.",
      'Finds YouTube repair videos for each code, with your own Anthropic and YouTube keys.',
    ],
    requirements: [
      'Android 7 or newer.',
      'An ELM327 Bluetooth adapter, Classic or BLE.',
      'A Google account to sign in.',
    ],
    icon: GAUGE,
  },
];

export function appPage(slug: string): AppPage | undefined {
  return APP_PAGES.find((a) => a.slug === slug);
}
