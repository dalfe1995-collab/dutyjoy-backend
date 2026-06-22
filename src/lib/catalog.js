/**
 * Catálogo de servicios y ciudades — fuente: BD con fallback estático.
 */
const prisma = require('./prisma');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
let servicesCache = { at: 0, data: null };
let citiesCache = { at: 0, data: null };

const FALLBACK_SERVICES = [
  { id: 'limpieza', nombre: 'Limpieza del hogar', icon: '🧹', descripcion: 'Limpieza general, organización y desinfección de espacios', color: '#0ABFBC', activo: true, orden: 1 },
  { id: 'aseo', nombre: 'Aseo del hogar', icon: '🧹', descripcion: 'Limpieza general, organización y desinfección de espacios', color: '#0ABFBC', activo: true, orden: 2 },
  { id: 'plomeria', nombre: 'Plomería', icon: '🔧', descripcion: 'Reparación de tuberías, grifos, inodoros y sistemas de agua', color: '#667eea', activo: true, orden: 3 },
  { id: 'electricidad', nombre: 'Electricidad', icon: '⚡', descripcion: 'Instalaciones eléctricas, tomacorrientes y luminarias', color: '#FFD93D', activo: true, orden: 4 },
  { id: 'pintura', nombre: 'Pintura', icon: '🎨', descripcion: 'Pintura de interiores, exteriores y fachadas', color: '#FF9F43', activo: true, orden: 5 },
  { id: 'jardineria', nombre: 'Jardinería', icon: '🌿', descripcion: 'Corte de pasto, poda, siembra y mantenimiento de jardines', color: '#00C9A7', activo: true, orden: 6 },
  { id: 'carpinteria', nombre: 'Carpintería', icon: '🔨', descripcion: 'Muebles, reparaciones y trabajos en madera', color: '#a78bfa', activo: true, orden: 7 },
  { id: 'cerrajeria', nombre: 'Cerrajería', icon: '🔑', descripcion: 'Apertura de puertas, cambio de cerraduras y duplicado de llaves', color: '#FF6B6B', activo: true, orden: 8 },
  { id: 'mudanzas', nombre: 'Mudanzas y trasteos', icon: '📦', descripcion: 'Empaque, carga y transporte de muebles y enseres', color: '#0891B2', activo: true, orden: 9 },
  { id: 'aire_acondicionado', nombre: 'Aire acondicionado', icon: '❄️', descripcion: 'Instalación, mantenimiento y reparación de aires acondicionados', color: '#6EE7F7', activo: true, orden: 10 },
  { id: 'fumigacion', nombre: 'Fumigación', icon: '🪲', descripcion: 'Control de plagas y fumigación residencial o comercial', color: '#84cc16', activo: true, orden: 11 },
  { id: 'instalaciones', nombre: 'Instalación y ensamblaje', icon: '🔩', descripcion: 'Instalación de electrodomésticos, equipos y ensamblaje de muebles', color: '#3b82f6', activo: true, orden: 12 },
  { id: 'seguridad', nombre: 'Escolta y seguridad', icon: '🛡️', descripcion: 'Servicio de escolta y seguridad personal por horas', color: '#334155', activo: true, orden: 13 },
  { id: 'cocina', nombre: 'Cocina a domicilio', icon: '🍳', descripcion: 'Preparación de alimentos, eventos y servicio de chef en casa', color: '#f97316', activo: true, orden: 14 },
  { id: 'cuidado', nombre: 'Cuidado de personas', icon: '👶', descripcion: 'Cuidado de niños, adultos mayores y personas con necesidades especiales', color: '#ec4899', activo: true, orden: 15 },
];

const FALLBACK_CITIES = [
  { id: 'bogota', nombre: 'Bogotá', lat: 4.711, lng: -74.0721, activo: true, orden: 1 },
  { id: 'medellin', nombre: 'Medellín', lat: 6.2442, lng: -75.5812, activo: true, orden: 2 },
  { id: 'cali', nombre: 'Cali', lat: 3.4516, lng: -76.532, activo: true, orden: 3 },
  { id: 'ibague', nombre: 'Ibagué', lat: 4.4389, lng: -75.2322, activo: true, orden: 4 },
  { id: 'barranquilla', nombre: 'Barranquilla', lat: 10.9685, lng: -74.7813, activo: true, orden: 5 },
  { id: 'cartagena', nombre: 'Cartagena', lat: 10.3997, lng: -75.5144, activo: true, orden: 6 },
  { id: 'bucaramanga', nombre: 'Bucaramanga', lat: 7.1193, lng: -73.1227, activo: true, orden: 7 },
  { id: 'pereira', nombre: 'Pereira', lat: 4.8133, lng: -75.6961, activo: true, orden: 8 },
];

function isFresh(cache) {
  return cache.data && Date.now() - cache.at < CACHE_TTL_MS;
}

function invalidateCatalogCache() {
  servicesCache = { at: 0, data: null };
  citiesCache = { at: 0, data: null };
}

async function getServices({ includeInactive = false } = {}) {
  if (isFresh(servicesCache) && !includeInactive) return servicesCache.data;

  try {
    const rows = await prisma.serviceCatalog.findMany({
      where: includeInactive ? {} : { activo: true },
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
    });
    if (rows.length > 0) {
      const data = rows.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        icon: s.icon || '',
        descripcion: s.descripcion || undefined,
        color: s.color || undefined,
      }));
      if (!includeInactive) {
        servicesCache = { at: Date.now(), data };
      }
      return data;
    }
  } catch (err) {
    console.warn('[catalog] getServices fallback:', err.message);
  }

  const data = FALLBACK_SERVICES.filter((s) => includeInactive || s.activo).map(({ activo, orden, ...rest }) => rest);
  if (!includeInactive) servicesCache = { at: Date.now(), data };
  return data;
}

async function getServiceById(id) {
  const services = await getServices({ includeInactive: true });
  return services.find((s) => s.id === id) || null;
}

async function getServiceIds({ includeInactive = false } = {}) {
  const services = await getServices({ includeInactive });
  return services.map((s) => s.id);
}

async function getCities({ includeInactive = false } = {}) {
  if (isFresh(citiesCache) && !includeInactive) return citiesCache.data;

  try {
    const rows = await prisma.cityCatalog.findMany({
      where: includeInactive ? {} : { activo: true },
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
    });
    if (rows.length > 0) {
      const data = rows.map((c) => ({
        id: c.id,
        nombre: c.nombre,
        lat: c.lat ?? undefined,
        lng: c.lng ?? undefined,
      }));
      if (!includeInactive) {
        citiesCache = { at: Date.now(), data };
      }
      return data;
    }
  } catch (err) {
    console.warn('[catalog] getCities fallback:', err.message);
  }

  const data = FALLBACK_CITIES.filter((c) => includeInactive || c.activo).map(({ activo, orden, ...rest }) => rest);
  if (!includeInactive) citiesCache = { at: Date.now(), data };
  return data;
}

async function getCityBySlug(slug) {
  const cities = await getCities({ includeInactive: true });
  return cities.find((c) => c.id === slug) || null;
}

async function getCityNames({ includeInactive = false } = {}) {
  const cities = await getCities({ includeInactive });
  return cities.map((c) => c.nombre);
}

module.exports = {
  FALLBACK_SERVICES,
  FALLBACK_CITIES,
  getServices,
  getServiceById,
  getServiceIds,
  getCities,
  getCityBySlug,
  getCityNames,
  invalidateCatalogCache,
};
