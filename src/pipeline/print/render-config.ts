/**
 * Configuracion de render de la Etapa 2 (refs off-page + paginacion).
 *
 * Estos parametros se afinan visualmente en el preview y se persisten en
 * render-config.json. Son la config REAL: la Etapa 3 (Visio) consume los mismos
 * valores. El preview es el afinador oficial, no un juguete.
 *
 * Unidades: pixeles del lienzo BPMN DI (mismo espacio que las coordenadas del
 * layout). La conversion a pulgadas/mm es responsabilidad de la Etapa 3.
 */

/** Tamanos de pagina conocidos, en px a 96 dpi. Landscape. */
export const PAGE_SIZES = {
  carta: { name: 'Carta horizontal', width: 1056, height: 816 },
  a4: { name: 'A4 horizontal', width: 1123, height: 794 },
} as const;

export type PageSizeKey = keyof typeof PAGE_SIZES;

export interface PaginationConfig {
  /** Habilita el calculo de la grilla de paginas. */
  enabled: boolean;
  /** Tamano de pagina base. */
  pageSize: PageSizeKey;
  /** Margen interno de cada pagina en px (zona no imprimible / respiro). */
  marginPx: number;
}

export interface RenderConfig {
  pagination: PaginationConfig;
}

export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  pagination: {
    enabled: true,
    pageSize: 'carta',
    marginPx: 24,
  },
};

/** Clamp numerico defensivo (los valores llegan de query params externos). */
function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return fallback;
}

/**
 * Construye un RenderConfig a partir de una base + overrides parciales
 * (típicamente los query params del preview). Valida y aplica clamps.
 */
export function resolveConfig(
  base: RenderConfig,
  overrides: Record<string, unknown> = {},
): RenderConfig {
  const pageSize: PageSizeKey =
    overrides.pageSize === 'a4' || overrides.pageSize === 'carta'
      ? overrides.pageSize
      : base.pagination.pageSize;

  return {
    pagination: {
      enabled: bool(overrides.pageEnabled, base.pagination.enabled),
      pageSize,
      marginPx: num(overrides.margin, base.pagination.marginPx, 0, 400),
    },
  };
}
