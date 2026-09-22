import { LOGO_VOX_DARK as logoDark, LOGO_VOX_LIGHT as logoLight } from "../assets/logos";

/**
 * The VOX Cinemas logo exactly as the public site ships it (blue "M" symbol, VOX wordmark, Arabic lockup).
 * Both variants render; styles.css shows the one matching the browser's colour scheme.
 */
export function BrandLogo({ className = "", height = 32 }: { className?: string; height?: number }) {
  return (
    <span className={`brand-logo ${className}`.trim()}>
      <img className="light" src={logoLight} alt="VOX Cinemas" height={height} width={Math.round(height * 3.13)} decoding="async" />
      <img className="dark" src={logoDark} alt="" aria-hidden="true" height={height} width={Math.round(height * 3.13)} decoding="async" />
    </span>
  );
}
