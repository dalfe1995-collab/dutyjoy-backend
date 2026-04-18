const router = require('express').Router();

// Catálogo de servicios disponibles en DutyJoy
const SERVICIOS = [
  { id: 'aseo',         nombre: 'Aseo del hogar',      icon: '🧹', descripcion: 'Limpieza general, organización y desinfección de espacios' },
  { id: 'jardineria',   nombre: 'Jardinería',           icon: '🌿', descripcion: 'Corte de pasto, poda, siembra y mantenimiento de jardines' },
  { id: 'plomeria',     nombre: 'Plomería',             icon: '🔧', descripcion: 'Reparación de tuberías, grifos, inodoros y sistemas de agua' },
  { id: 'electricidad', nombre: 'Electricidad',         icon: '⚡', descripcion: 'Instalaciones eléctricas, tomacorrientes y luminarias' },
  { id: 'cocina',       nombre: 'Cocina a domicilio',   icon: '🍳', descripcion: 'Preparación de alimentos, eventos y servicio de chef en casa' },
  { id: 'mudanzas',     nombre: 'Mudanzas y trasteos',  icon: '📦', descripcion: 'Empaque, carga y transporte de muebles y enseres' },
  { id: 'cuidado',      nombre: 'Cuidado de personas',  icon: '👶', descripcion: 'Cuidado de niños, adultos mayores y personas con necesidades especiales' },
  { id: 'pintura',      nombre: 'Pintura',              icon: '🎨', descripcion: 'Pintura de interiores, exteriores y fachadas' },
];

// GET /services — catálogo completo de servicios
router.get('/', (_req, res) => {
  res.json({ services: SERVICIOS, total: SERVICIOS.length });
});

// GET /services/:id — detalle de un servicio específico
router.get('/:id', (req, res) => {
  const servicio = SERVICIOS.find(s => s.id === req.params.id);
  if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
  res.json(servicio);
});

module.exports = router;
module.exports.SERVICIOS_IDS = SERVICIOS.map(s => s.id);
