/**
 * „← Werkstatt“ above the title of every page listed in the Werkstatt
 * (Prüfrunde 1, aussehen 16). On its own, so pages outside the workshop
 * need none of its code.
 */
import { ArrowLeft } from 'lucide-preact';

export function BackToWorkshop() {
  return (
    <a class="back-link" href="#/werkstatt">
      <ArrowLeft size={16} /> Werkstatt
    </a>
  );
}
