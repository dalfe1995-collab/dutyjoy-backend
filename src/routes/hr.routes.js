/**
 * hr.routes.js — AI-powered Human Resources management
 * Employees · Recruitment · Performance · Learning · Pulse · Copilot
 */
const router      = require('express').Router();
const OpenAI      = require('openai');
const verifyToken = require('../middleware/verifyToken');
const prisma      = require('../lib/prisma');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo administradores.' });
  next();
};

const ai = (prompt, { model = 'gpt-4o-mini', max_tokens = 1200, json = true, temp = 0.6 } = {}) => {
  if (!openai) return Promise.reject(new Error('OPENAI_API_KEY no configurado'));
  return openai.chat.completions.create({
    model,
    max_tokens,
    temperature: temp,
    ...(json && { response_format: { type: 'json_object' } }),
    messages: [{ role: 'user', content: prompt }],
  }).then(r => json ? JSON.parse(r.choices[0].message.content) : r.choices[0].message.content);
};

// ══════════════════════════════════════════════════════════════
//  EMPLOYEES CRUD
// ══════════════════════════════════════════════════════════════
router.get('/employees', verifyToken, soloAdmin, async (req, res) => {
  const { dept, estado, search } = req.query;
  const where = {
    ...(dept   && { dept }),
    ...(estado && { estado }),
    ...(search && { OR: [{ nombre: { contains: search, mode: 'insensitive' } }, { cargo: { contains: search, mode: 'insensitive' } }] }),
  };
  const [employees, total] = await Promise.all([
    prisma.employee.findMany({ where, orderBy: { nombre: 'asc' }, include: { _count: { select: { reviews: true, ptoRequests: true } } } }),
    prisma.employee.count({ where }),
  ]);
  res.json({ employees, total });
});

router.post('/employees', verifyToken, soloAdmin, async (req, res) => {
  const { nombre, email, cargo, dept, tipo, salario, inicio, skills, telefono, nivelSalarial, reportaA } = req.body;
  if (!nombre || !email || !cargo || !dept) return res.status(400).json({ error: 'nombre, email, cargo y dept requeridos' });
  const emp = await prisma.employee.create({
    data: { nombre, email, cargo, dept, tipo: tipo || 'TIEMPO_COMPLETO', salario: parseFloat(salario) || 0,
      inicio: inicio ? new Date(inicio) : new Date(), skills: skills || [], telefono, nivelSalarial, reportaA },
  });
  res.status(201).json({ ok: true, employee: emp });
});

router.patch('/employees/:id', verifyToken, soloAdmin, async (req, res) => {
  const allowed = ['nombre','email','cargo','dept','tipo','salario','estado','performance','skills','vacaciones','telefono','nivelSalarial','notas','reportaA'];
  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (data.salario) data.salario = parseFloat(data.salario);
  if (data.vacaciones) data.vacaciones = parseInt(data.vacaciones);
  const emp = await prisma.employee.update({ where: { id: req.params.id }, data });
  res.json({ ok: true, employee: emp });
});

router.delete('/employees/:id', verifyToken, soloAdmin, async (req, res) => {
  await prisma.employee.update({ where: { id: req.params.id }, data: { estado: 'INACTIVO' } });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
//  JOB POSITIONS CRUD
// ══════════════════════════════════════════════════════════════
router.get('/positions', verifyToken, soloAdmin, async (req, res) => {
  const positions = await prisma.jobPosition.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ positions });
});

router.post('/positions', verifyToken, soloAdmin, async (req, res) => {
  const { cargo, dept, prioridad, salarioMin, salarioMax, ubicacion } = req.body;
  if (!cargo || !dept) return res.status(400).json({ error: 'cargo y dept requeridos' });
  const pos = await prisma.jobPosition.create({ data: { cargo, dept, prioridad: prioridad || 'MEDIA', salarioMin: parseFloat(salarioMin) || null, salarioMax: parseFloat(salarioMax) || null, ubicacion: ubicacion || 'Remoto/Ibagué' } });
  res.status(201).json({ ok: true, position: pos });
});

router.patch('/positions/:id', verifyToken, soloAdmin, async (req, res) => {
  const allowed = ['estado','candidatos','publicadaEn','descripcion'];
  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const pos = await prisma.jobPosition.update({ where: { id: req.params.id }, data });
  res.json({ ok: true, position: pos });
});

// ══════════════════════════════════════════════════════════════
//  PERFORMANCE REVIEWS CRUD
// ══════════════════════════════════════════════════════════════
router.get('/reviews', verifyToken, soloAdmin, async (req, res) => {
  const { employeeId, periodo } = req.query;
  const reviews = await prisma.performanceReview.findMany({
    where: { ...(employeeId && { employeeId }), ...(periodo && { periodo }) },
    include: { employee: { select: { nombre: true, cargo: true, dept: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ reviews });
});

router.patch('/reviews/:id', verifyToken, soloAdmin, async (req, res) => {
  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => ['score','metasAlcanzadas','fortalezas','areasMejora','comentario','estado'].includes(k)));
  if (data.metasAlcanzadas) data.metasAlcanzadas = parseFloat(data.metasAlcanzadas);
  const rev = await prisma.performanceReview.update({ where: { id: req.params.id }, data });
  // Update employee performance score
  if (data.score && data.estado === 'completada') {
    const review = await prisma.performanceReview.findUnique({ where: { id: req.params.id } });
    await prisma.employee.update({ where: { id: review.employeeId }, data: { performance: data.score } });
  }
  res.json({ ok: true, review: rev });
});

// ══════════════════════════════════════════════════════════════
//  PTO REQUESTS CRUD
// ══════════════════════════════════════════════════════════════
router.get('/pto', verifyToken, soloAdmin, async (req, res) => {
  const pto = await prisma.ptoRequest.findMany({
    include: { employee: { select: { nombre: true, cargo: true, dept: true, vacaciones: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ pto });
});

router.post('/pto', verifyToken, soloAdmin, async (req, res) => {
  const { employeeId, tipo, desde, hasta, motivo } = req.body;
  const d1 = new Date(desde), d2 = new Date(hasta);
  const dias = Math.ceil((d2 - d1) / 86400000) + 1;
  const pto = await prisma.ptoRequest.create({ data: { employeeId, tipo, desde: d1, hasta: d2, dias, motivo } });
  res.status(201).json({ ok: true, pto });
});

router.patch('/pto/:id', verifyToken, soloAdmin, async (req, res) => {
  const { estado, aprobadoPor } = req.body;
  const pto = await prisma.ptoRequest.update({ where: { id: req.params.id }, data: { estado, aprobadoPor } });
  if (estado === 'APROBADA' && pto.tipo === 'VACACIONES') {
    await prisma.employee.update({ where: { id: pto.employeeId }, data: { vacaciones: { decrement: pto.dias } } });
  }
  res.json({ ok: true, pto });
});

// ══════════════════════════════════════════════════════════════
//  PULSE SURVEYS CRUD
// ══════════════════════════════════════════════════════════════
router.get('/pulses', verifyToken, soloAdmin, async (req, res) => {
  const pulses = await prisma.hrPulse.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ pulses });
});

router.patch('/pulses/:id', verifyToken, soloAdmin, async (req, res) => {
  const { estado, respuestas } = req.body;
  const pulse = await prisma.hrPulse.update({ where: { id: req.params.id }, data: { ...(estado && { estado }), ...(respuestas && { respuestas }) } });
  res.json({ ok: true, pulse });
});

// ══════════════════════════════════════════════════════════════
//  AI — JOB DESCRIPTION GENERATOR
// ══════════════════════════════════════════════════════════════
router.post('/ai/job-description', verifyToken, soloAdmin, async (req, res) => {
  const { cargo, dept, nivel = 'mid', salarioMin, salarioMax, remoto = true, contexto = '' } = req.body;
  if (!cargo || !dept) return res.status(400).json({ error: 'cargo y dept requeridos' });

  const [empCount, openPositions] = await Promise.all([
    prisma.employee.count({ where: { dept, estado: 'ACTIVO' } }),
    prisma.jobPosition.count({ where: { dept, estado: { notIn: ['CERRADA'] } } }),
  ]).catch(() => [0, 0]);

  const prompt = `Eres el Head of Talent de DutyJoy, startup colombiana de servicios del hogar (marketplace, 10-15 personas).
Contexto equipo ${dept}: ${empCount} personas activas, ${openPositions} vacantes abiertas.
${contexto ? `Contexto adicional: ${contexto}` : ''}

Crea una descripción de cargo COMPLETA y ATRACTIVA para:
- Cargo: ${cargo}
- Departamento: ${dept}
- Nivel: ${nivel}
- Salario: ${salarioMin ? `$${Number(salarioMin).toLocaleString('es-CO')} - $${Number(salarioMax).toLocaleString('es-CO')} COP/mes` : 'Competitivo según experiencia'}
- Modalidad: ${remoto ? 'Remoto/Híbrido (Ibagué o Colombia)' : 'Presencial Ibagué'}

Genera en español colombiano, directo, sin jerga corporativa aburrida. DutyJoy es un equipo joven y apasionado.

Responde SOLO JSON:
{
  "titulo_publicacion": "<título atractivo para LinkedIn>",
  "resumen": "<2-3 oraciones que enganchen al candidato ideal>",
  "sobre_dutyjoy": "<párrafo de 3-4 oraciones sobre la empresa, misión, impacto>",
  "el_rol": "<descripción del rol en 2-3 oraciones, qué problemas resolverá>",
  "responsabilidades": ["<R1>","<R2>","<R3>","<R4>","<R5>","<R6>"],
  "requisitos_indispensables": ["<R1>","<R2>","<R3>","<R4>"],
  "requisitos_deseables": ["<D1>","<D2>","<D3>"],
  "beneficios": ["<B1>","<B2>","<B3>","<B4>","<B5>"],
  "como_aplicar": "<instrucciones claras para aplicar>",
  "tags_linkedin": ["<tag1>","<tag2>","<tag3>","<tag4>","<tag5>"],
  "salario_benchmark": { "mercado_min": <number COP>, "mercado_max": <number COP>, "recomendacion": "<1 oración>" },
  "perfil_ideal": "<descripción del candidato perfecto en 2-3 oraciones>",
  "preguntas_filtro": ["<pregunta aplicación 1>","<pregunta 2>","<pregunta 3>"]
}`;

  try {
    const brief = await ai(prompt, { model: 'gpt-4o', max_tokens: 2000, temp: 0.65 });
    if (req.body.positionId) {
      await prisma.jobPosition.update({ where: { id: req.body.positionId }, data: { aiBrief: brief, descripcion: brief.resumen, requisitos: brief.requisitos_indispensables || [] } });
    }
    res.json({ brief, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — INTERVIEW QUESTIONS GENERATOR
// ══════════════════════════════════════════════════════════════
router.post('/ai/interview-questions', verifyToken, soloAdmin, async (req, res) => {
  const { cargo, dept, nivel = 'mid', etapa = 'todas', skills = [] } = req.body;
  if (!cargo) return res.status(400).json({ error: 'cargo requerido' });

  const prompt = `Eres recruiter senior de DutyJoy, startup colombiana de servicios del hogar.
Genera preguntas de entrevista para: ${cargo} (${dept}, nivel ${nivel}).
Skills clave: ${skills.join(', ') || 'según el rol'}.
Etapa solicitada: ${etapa}.

Responde SOLO JSON:
{
  "screening": {
    "duracion": "20-30 minutos",
    "objetivo": "<qué evaluar>",
    "preguntas": [
      {"pregunta":"<P>","evalua":"<qué competencia>","seniales_positivas":"<qué respuesta buscar>","red_flags":"<señales de alerta>"}
    ]
  },
  "tecnica": {
    "duracion": "45-60 minutos",
    "objetivo": "<qué evaluar>",
    "preguntas": [
      {"pregunta":"<P>","evalua":"<qué>","tipo":"tecnica|caso|situacional","dificultad":"basica|media|avanzada"}
    ],
    "ejercicio_practico": {"descripcion":"<ejercicio>","tiempo":"<minutos>","criterios_evaluacion":["<C1>","<C2>"]}
  },
  "cultural": {
    "duracion": "30 minutos",
    "objetivo": "<fit cultural DutyJoy>",
    "preguntas": [
      {"pregunta":"<P>","evalua":"<valor DutyJoy que mide>"}
    ]
  },
  "referencias": ["<pregunta ref 1>","<pregunta ref 2>","<pregunta ref 3>"],
  "scorecard": {
    "dimensiones": [
      {"nombre":"<dimensión>","peso_pct":<number>,"criterios":["<C1>","<C2>"]}
    ]
  }
}`;

  try {
    const questions = await ai(prompt, { model: 'gpt-4o', max_tokens: 2500, temp: 0.5 });
    if (req.body.positionId) {
      await prisma.jobPosition.update({ where: { id: req.body.positionId }, data: { aiQuestions: questions } });
    }
    res.json({ questions, cargo, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — CANDIDATE SCREENER
// ══════════════════════════════════════════════════════════════
router.post('/ai/screen-candidate', verifyToken, soloAdmin, async (req, res) => {
  const { cargo, dept, nivel, requisitos = [], perfil, cvTexto } = req.body;
  if (!cargo || (!perfil && !cvTexto)) return res.status(400).json({ error: 'cargo y (perfil o cvTexto) requeridos' });

  const prompt = `Eres recruiter senior de DutyJoy. Evalúa este candidato para ${cargo} en ${dept} (nivel ${nivel || 'mid'}).

REQUISITOS INDISPENSABLES:
${requisitos.map((r, i) => `${i + 1}. ${r}`).join('\n') || 'Según el rol'}

PERFIL / CV DEL CANDIDATO:
${perfil || cvTexto}

Evalúa objetivamente. Sé directo y honesto. No exageres ni en positivo ni en negativo.

Responde SOLO JSON:
{
  "score_total": <0-100>,
  "recomendacion": "avanzar|revisar|descartar",
  "confianza": "alta|media|baja",
  "resumen_ejecutivo": "<3-4 oraciones directas sobre el candidato>",
  "match_requisitos": [
    {"requisito":"<req>","cumple":true|false,"evidencia":"<qué indica que cumple o no>"}
  ],
  "fortalezas": ["<F1>","<F2>","<F3>"],
  "preocupaciones": ["<P1>","<P2>"],
  "preguntas_profundizar": ["<pregunta para la entrevista 1>","<pregunta 2>","<pregunta 3>"],
  "salario_esperado_estimado": {"min":<COP>,"max":<COP>,"base":"<qué indica esto>"},
  "tiempo_onboarding_estimado": "<ej: 2 semanas>",
  "fit_cultural": {"score":<0-10>,"razon":"<por qué>"}
}`;

  try {
    const screening = await ai(prompt, { model: 'gpt-4o', max_tokens: 1500, temp: 0.3 });
    res.json({ screening, cargo, screenedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — PERFORMANCE REVIEW WRITER
// ══════════════════════════════════════════════════════════════
router.post('/ai/performance-review', verifyToken, soloAdmin, async (req, res) => {
  const { employeeId, periodo, tipo = 'trimestral', notasManager = '', okrResults = [] } = req.body;
  if (!employeeId) return res.status(400).json({ error: 'employeeId requerido' });

  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

  const pastReviews = await prisma.performanceReview.findMany({
    where: { employeeId },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { periodo: true, score: true, areasMejora: true, fortalezas: true },
  });

  const prompt = `Eres el HR Manager de DutyJoy escribiendo una evaluación de desempeño ${tipo} justa, específica y constructiva.

EMPLEADO:
- Nombre: ${emp.nombre}
- Cargo: ${emp.cargo}
- Departamento: ${emp.dept}
- Nivel: ${emp.nivelSalarial || 'mid'}
- Tiempo en empresa: ${Math.round((Date.now() - new Date(emp.inicio)) / (86400000 * 30))} meses

NOTAS DEL MANAGER:
${notasManager || 'Sin notas adicionales'}

RESULTADOS OKR / PROYECTOS:
${okrResults.length ? okrResults.map(o => `- ${o.objetivo}: ${o.progreso}%`).join('\n') : 'Sin datos específicos de OKR'}

HISTORIAL:
${pastReviews.length ? pastReviews.map(r => `${r.periodo}: ${r.score} | Mejoras: ${r.areasMejora}`).join('\n') : 'Primera evaluación'}

Escribe una evaluación honesta, específica y accionable. Evita el lenguaje genérico.
Calibra el score basado en lo que se describe.

Responde SOLO JSON:
{
  "score_recomendado": "EXCELENTE|BUENO|REGULAR|BAJO",
  "metas_alcanzadas_pct": <0-100>,
  "resumen_ejecutivo": "<párrafo de 3-4 oraciones directo y específico>",
  "fortalezas": {
    "narrativa": "<párrafo describiendo las principales fortalezas con ejemplos>",
    "lista": ["<F1>","<F2>","<F3>"]
  },
  "areas_mejora": {
    "narrativa": "<párrafo sobre áreas de desarrollo, tono constructivo>",
    "lista": ["<A1>","<A2>"]
  },
  "logros_destacados": ["<L1>","<L2>","<L3>"],
  "objetivos_proximo_periodo": [
    {"objetivo":"<O>","metrica":"<cómo medirlo>","plazo":"<cuándo>"}
  ],
  "plan_desarrollo": {
    "habilidades_a_desarrollar": ["<H1>","<H2>"],
    "recursos_recomendados": ["<R1>","<R2>"],
    "acciones_concretas": ["<A1>","<A2>"]
  },
  "recomendacion_compensacion": "aumento|mantener|revisar",
  "notas_confidenciales": "<observaciones solo para RRHH, si aplica>"
}`;

  try {
    const draft = await ai(prompt, { model: 'gpt-4o', max_tokens: 2000, temp: 0.5 });

    // Persist review draft
    const review = await prisma.performanceReview.create({
      data: {
        employeeId,
        periodo: periodo || `${new Date().getFullYear()}-Q${Math.ceil((new Date().getMonth() + 1) / 3)}`,
        tipo,
        aiBorrador: JSON.stringify(draft),
        score: draft.score_recomendado,
        metasAlcanzadas: draft.metas_alcanzadas_pct,
        fortalezas: draft.fortalezas?.lista?.join(' | '),
        areasMejora: draft.areas_mejora?.lista?.join(' | '),
        estado: 'borrador',
        revisorNombre: 'IA — Pendiente revisión manager',
      },
    });

    res.json({ draft, reviewId: review.id, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — LEARNING PATH GENERATOR
// ══════════════════════════════════════════════════════════════
router.post('/ai/learning-path', verifyToken, soloAdmin, async (req, res) => {
  const { employeeId, metaCarrera = '', presupuesto = 500000 } = req.body;
  if (!employeeId) return res.status(400).json({ error: 'employeeId requerido' });

  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

  const lastReview = await prisma.performanceReview.findFirst({
    where: { employeeId },
    orderBy: { createdAt: 'desc' },
  });

  const prompt = `Eres el L&D (Learning & Development) Manager de DutyJoy.
Crea un plan de aprendizaje personalizado para los próximos 3-6 meses.

EMPLEADO:
- Nombre: ${emp.nombre}
- Cargo actual: ${emp.cargo}
- Departamento: ${emp.dept}
- Nivel: ${emp.nivelSalarial || 'mid'}
- Skills actuales: ${emp.skills.join(', ') || 'No especificados'}
- Meses en empresa: ${Math.round((Date.now() - new Date(emp.inicio)) / (86400000 * 30))}

META DE CARRERA: ${metaCarrera || 'Crecer dentro de ' + emp.dept}
PRESUPUESTO DE CAPACITACIÓN: $${Number(presupuesto).toLocaleString('es-CO')} COP

ÚLTIMA EVALUACIÓN:
${lastReview ? `Score: ${lastReview.score} | Áreas mejora: ${lastReview.areasMejora}` : 'Sin evaluación previa'}

Crea un plan concreto, con recursos reales (Coursera, Udemy, YouTube, libros, etc.).

Responde SOLO JSON:
{
  "diagnostico": "<análisis de brechas entre situación actual y meta, 2-3 oraciones>",
  "objetivo_6_meses": "<qué debería poder hacer/ser en 6 meses>",
  "camino_carrera": ["<Cargo actual>","<Cargo en 12m>","<Cargo en 2 años>"],
  "fases": [
    {
      "fase": 1,
      "nombre": "<nombre de la fase>",
      "duracion": "<semanas>",
      "enfoque": "<qué trabajar>",
      "recursos": [
        {"tipo":"curso|libro|practica|mentoria","nombre":"<nombre>","plataforma":"<dónde>","url_sugerida":"<URL real>","horas_estimadas":<n>,"costo_cop":<n>,"prioridad":"alta|media|baja"}
      ],
      "meta_alcanzable": "<qué debe poder demostrar al final de la fase>"
    }
  ],
  "costo_total_estimado": <COP>,
  "horas_totales": <number>,
  "kpis_aprendizaje": ["<KPI 1>","<KPI 2>","<KPI 3>"],
  "checkins_recomendados": "<con qué frecuencia hacer seguimiento y qué revisar>",
  "recursos_gratuitos_destacados": ["<R1 gratis>","<R2 gratis>","<R3 gratis>"]
}`;

  try {
    const path = await ai(prompt, { model: 'gpt-4o', max_tokens: 2200, temp: 0.55 });
    res.json({ path, employee: { nombre: emp.nombre, cargo: emp.cargo }, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — 1:1 AGENDA GENERATOR
// ══════════════════════════════════════════════════════════════
router.post('/ai/1on1-agenda', verifyToken, soloAdmin, async (req, res) => {
  const { employeeId, contexto = '', frecuencia = 'quincenal' } = req.body;
  if (!employeeId) return res.status(400).json({ error: 'employeeId requerido' });

  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  const lastReview = await prisma.performanceReview.findFirst({ where: { employeeId }, orderBy: { createdAt: 'desc' } });
  const pendingPto = await prisma.ptoRequest.count({ where: { employeeId, estado: 'PENDIENTE' } });

  const prompt = `Eres el manager de ${emp.nombre} en DutyJoy.
Genera una agenda de 1:1 efectiva, orientada a crecimiento y resultados.

CONTEXTO:
- Empleado: ${emp.nombre} (${emp.cargo}, ${emp.dept})
- Frecuencia: ${frecuencia}
- Última evaluación: ${lastReview?.score || 'N/A'} | Áreas mejora: ${lastReview?.areasMejora || 'N/A'}
- PTO pendientes: ${pendingPto}
- Notas adicionales: ${contexto || 'Ninguna'}

Responde SOLO JSON:
{
  "duracion_recomendada": "30|45|60 minutos",
  "estructura": [
    {"bloque":"<nombre>","tiempo":"<min>","objetivo":"<para qué>","preguntas":["<P1>","<P2>","<P3>"]}
  ],
  "temas_prioritarios": ["<T1>","<T2>","<T3>"],
  "preguntas_poderosas": ["<pregunta abre conversación 1>","<pregunta 2>","<pregunta 3>","<pregunta 4>","<pregunta 5>"],
  "check_bienestar": ["<pregunta bienestar 1>","<pregunta bienestar 2>"],
  "seguimiento_anterior": "${lastReview ? 'Revisar avance en: ' + (lastReview.areasMejora || 'pendientes') : 'Primera sesión — establecer expectativas'}",
  "cierre_recomendado": "<cómo cerrar la sesión productivamente>",
  "template_notas": {
    "logros_desde_ultima_vez": "",
    "bloqueos_actuales": "",
    "necesita_de_mi": "",
    "compromisos": [],
    "proxima_cita": ""
  }
}`;

  try {
    const agenda = await ai(prompt, { max_tokens: 1400, temp: 0.6 });
    res.json({ agenda, employee: { nombre: emp.nombre, cargo: emp.cargo, dept: emp.dept }, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — SALARY BENCHMARK
// ══════════════════════════════════════════════════════════════
router.post('/ai/salary-benchmark', verifyToken, soloAdmin, async (req, res) => {
  const { cargo, dept, nivel = 'mid', ciudad = 'Ibagué', tipo = 'TIEMPO_COMPLETO', skills = [] } = req.body;
  if (!cargo) return res.status(400).json({ error: 'cargo requerido' });

  const teamStats = await prisma.employee.aggregate({
    where: { dept, estado: 'ACTIVO' },
    _avg: { salario: true },
    _min: { salario: true },
    _max: { salario: true },
  }).catch(() => ({ _avg: {}, _min: {}, _max: {} }));

  const prompt = `Eres consultor de compensación para startups colombianas.
Analiza el mercado salarial para:

CARGO: ${cargo}
DEPARTAMENTO: ${dept}
NIVEL: ${nivel} (junior|mid|senior|lead|director)
CIUDAD: ${ciudad}
TIPO: ${tipo}
SKILLS CLAVE: ${skills.join(', ') || 'estándar del rol'}

CONTEXTO EQUIPO ${dept}:
Salario promedio actual: ${teamStats._avg.salario ? '$' + Math.round(teamStats._avg.salario).toLocaleString('es-CO') + ' COP' : 'Sin datos'}

Usa conocimiento de mercado colombiano 2025 (Computrabajo, LinkedIn Salary, Hays, Michael Page Colombia).

Responde SOLO JSON:
{
  "rango_mercado": {
    "p25": <COP>,
    "p50": <COP>,
    "p75": <COP>,
    "p90": <COP>
  },
  "recomendacion_dutyjoy": {
    "base": <COP>,
    "razon": "<por qué este número>",
    "variables": "<bonos, equity, beneficios equivalentes>"
  },
  "benchmarks_referencia": [
    {"empresa":"<tipo empresa>","rango_min":<COP>,"rango_max":<COP>,"nota":"<contexto>"}
  ],
  "factores_ajuste": [
    {"factor":"<nombre>","impacto":"positivo|negativo","valor_pct":<pct>,"explicacion":"<por qué>"}
  ],
  "beneficios_recomendados": ["<B1>","<B2>","<B3>","<B4>","<B5>"],
  "equity_sugerido": {"pct":"<0.0x%>","vesting":"<schedule>","aplicable":true|false},
  "competitividad_actual": "<análisis si la empresa es competitiva en compensación>",
  "riesgo_fuga": "alto|medio|bajo",
  "fuentes_datos": ["<fuente 1>","<fuente 2>"]
}`;

  try {
    const benchmark = await ai(prompt, { model: 'gpt-4o', max_tokens: 1500, temp: 0.3 });
    res.json({ benchmark, cargo, nivel, ciudad, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — PULSE SURVEY GENERATOR
// ══════════════════════════════════════════════════════════════
router.post('/ai/pulse-survey', verifyToken, soloAdmin, async (req, res) => {
  const { enfoque = 'general', duracion = '3 minutos', contexto = '' } = req.body;

  const [empCount, avgPerf] = await Promise.all([
    prisma.employee.count({ where: { estado: 'ACTIVO' } }),
    prisma.employee.findMany({ where: { estado: 'ACTIVO', performance: { not: null } }, select: { performance: true } }),
  ]).catch(() => [0, []]);

  const prompt = `Eres el People & Culture Manager de DutyJoy (${empCount} empleados activos, startup en crecimiento).
Crea una encuesta de pulso que tome ${duracion} y mida ${enfoque}.
Contexto: ${contexto || 'Equipo en modo crecimiento, varios roles nuevos, expansión de producto'}

Las preguntas deben ser específicas a DutyJoy, no genéricas. Mix de escalas + texto abierto.

Responde SOLO JSON:
{
  "titulo": "<título atractivo de la encuesta>",
  "descripcion": "<1-2 oraciones para el empleado explicando por qué responder>",
  "anonima": true,
  "preguntas": [
    {
      "id": "<id único>",
      "texto": "<pregunta>",
      "tipo": "escala_1_10|escala_1_5|nps|opcion_multiple|texto_libre|si_no",
      "opciones": ["<opción si aplica>"] ,
      "dimension": "<engagement|bienestar|colaboracion|liderazgo|crecimiento|satisfaccion>",
      "obligatoria": true|false
    }
  ],
  "cierre": "<mensaje de agradecimiento al terminar>",
  "frecuencia_recomendada": "semanal|quincenal|mensual|trimestral",
  "dimensiones_a_medir": ["<D1>","<D2>","<D3>"]
}`;

  try {
    const survey = await ai(prompt, { model: 'gpt-4o', max_tokens: 1800, temp: 0.7 });

    const pulse = await prisma.hrPulse.create({
      data: {
        titulo: survey.titulo,
        preguntas: survey.preguntas,
        estado: 'borrador',
      },
    });

    res.json({ survey, pulseId: pulse.id, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — ANALYZE PULSE RESULTS
// ══════════════════════════════════════════════════════════════
router.post('/ai/analyze-pulse/:id', verifyToken, soloAdmin, async (req, res) => {
  const pulse = await prisma.hrPulse.findUnique({ where: { id: req.params.id } });
  if (!pulse) return res.status(404).json({ error: 'Encuesta no encontrada' });
  if (!pulse.respuestas || !Array.isArray(pulse.respuestas) || pulse.respuestas.length === 0) {
    return res.status(400).json({ error: 'La encuesta no tiene respuestas aún' });
  }

  const prompt = `Eres el People Analytics Manager de DutyJoy.
Analiza los resultados de esta encuesta de pulso y genera insights accionables.

ENCUESTA: "${pulse.titulo}"
PREGUNTAS: ${JSON.stringify(pulse.preguntas)}
RESPUESTAS (${pulse.respuestas.length} participantes): ${JSON.stringify(pulse.respuestas)}

Analiza patrones, señales de alerta y oportunidades. Sé específico y accionable.

Responde SOLO JSON:
{
  "score_general": <0-10>,
  "participacion_pct": <0-100>,
  "resumen_ejecutivo": "<3-4 oraciones para el CEO/liderazgo>",
  "temas_positivos": [{"tema":"<tema>","evidencia":"<qué respuestas lo indican>","recomendacion":"<acción>"}],
  "alertas": [{"nivel":"critica|alta|media","tema":"<tema>","evidencia":"<qué indicó esto>","accion_urgente":"<qué hacer>"}],
  "dimensiones": [{"nombre":"<dimension>","score":<0-10>,"tendencia":"mejora|estable|riesgo","comentario":"<hallazgo>"}],
  "verbatims_destacados": ["<respuesta literal significativa 1>","<resp 2>","<resp 3>"],
  "plan_accion": [
    {"prioridad":"alta|media","accion":"<qué hacer>","responsable":"<quien>","plazo":"<cuándo>","impacto":"<resultado esperado>"}
  ],
  "proxima_medicion": "<cuándo volver a medir y qué cambiar>"
}`;

  try {
    const analisis = await ai(prompt, { model: 'gpt-4o', max_tokens: 1800, temp: 0.3 });

    await prisma.hrPulse.update({
      where: { id: req.params.id },
      data: { analisis: JSON.stringify(analisis), score: analisis.score_general, temas: analisis.temas_positivos, estado: 'cerrada' },
    });

    res.json({ analisis, pulseId: req.params.id, analyzedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — OFFER LETTER GENERATOR
// ══════════════════════════════════════════════════════════════
router.post('/ai/offer-letter', verifyToken, soloAdmin, async (req, res) => {
  const { candidatoNombre, cargo, dept, salario, fechaInicio, tipo, beneficios = [], modalidad = 'Remoto/Híbrido' } = req.body;
  if (!candidatoNombre || !cargo || !salario) return res.status(400).json({ error: 'candidatoNombre, cargo y salario requeridos' });

  const prompt = `Genera una carta de oferta de trabajo profesional y atractiva para DutyJoy SAS.

DATOS:
- Candidato: ${candidatoNombre}
- Cargo: ${cargo} — ${dept}
- Salario: $${Number(salario).toLocaleString('es-CO')} COP/mes
- Fecha de inicio: ${fechaInicio || 'A convenir'}
- Tipo: ${tipo || 'TIEMPO_COMPLETO'}
- Modalidad: ${modalidad}
- Beneficios adicionales: ${beneficios.join(', ') || 'Según política de empresa'}

Escribe en español formal pero cálido. Que el candidato sienta que está tomando la decisión correcta.
Incluye términos legales básicos colombianos (Código Sustantivo del Trabajo).

Responde SOLO JSON:
{
  "carta_html": "<carta completa en HTML con <h2>, <p>, <strong>, <ul> — lista todo en detalle>",
  "resumen_oferta": {
    "cargo": "${cargo}",
    "salario_base": ${salario},
    "beneficios_listados": ["<B1>","<B2>","<B3>"],
    "fecha_limite_respuesta": "<fecha sugerida>",
    "contacto": "rrhh@dutyjoy.com"
  },
  "talking_points_recruiter": ["<punto 1 para defender la oferta>","<punto 2>","<punto 3>"],
  "posibles_objeciones": [{"objecion":"<O>","respuesta":"<cómo manejarla>"}]
}`;

  try {
    const letter = await ai(prompt, { model: 'gpt-4o', max_tokens: 2000, temp: 0.6 });
    res.json({ letter, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — HR COPILOT (streaming-style chat)
// ══════════════════════════════════════════════════════════════
router.post('/ai/copilot', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY requerido' });

  const { messages: history = [], pregunta } = req.body;
  if (!pregunta) return res.status(400).json({ error: 'pregunta requerida' });

  // Pull live context
  const [empCount, openPos, pendingPto, avgSalary] = await Promise.all([
    prisma.employee.count({ where: { estado: 'ACTIVO' } }),
    prisma.jobPosition.count({ where: { estado: { notIn: ['CERRADA'] } } }),
    prisma.ptoRequest.count({ where: { estado: 'PENDIENTE' } }),
    prisma.employee.aggregate({ _avg: { salario: true }, where: { estado: 'ACTIVO' } }),
  ]).catch(() => [0, 0, 0, { _avg: {} }]);

  const systemPrompt = `Eres el HR Copilot IA de DutyJoy, asistente inteligente de Recursos Humanos.

CONTEXTO ACTUAL:
- ${empCount} empleados activos
- ${openPos} posiciones abiertas
- ${pendingPto} solicitudes PTO pendientes
- Salario promedio: ${avgSalary._avg.salario ? '$' + Math.round(avgSalary._avg.salario).toLocaleString('es-CO') + ' COP' : 'N/A'}

Tu especialidad: ley laboral colombiana, compensación, performance management, cultura organizacional, reclutamiento, onboarding, bienestar.

TONO: Directo, amigable, accionable. Sin rodeos. Si no sabes algo, dilo.
FORMATO: Responde en markdown cuando sea útil (listas, tablas, headers). Español colombiano.
RESTRICCIONES: No inventes leyes. Para temas legales específicos recomienda consultar abogado laboral.`;

  try {
    const msgs = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-8).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: pregunta },
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1000,
      temperature: 0.55,
      messages: msgs,
    });

    res.json({
      respuesta: completion.choices[0].message.content,
      role: 'assistant',
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — TEAM HEALTH DASHBOARD
// ══════════════════════════════════════════════════════════════
router.get('/ai/team-health', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY requerido' });

  const [employees, reviews, pto, positions] = await Promise.all([
    prisma.employee.findMany({ where: { estado: 'ACTIVO' }, select: { dept: true, performance: true, salario: true, vacaciones: true, inicio: true } }),
    prisma.performanceReview.findMany({ orderBy: { createdAt: 'desc' }, take: 20, select: { score: true, metasAlcanzadas: true, dept: { select: true } } }).catch(() => []),
    prisma.ptoRequest.findMany({ where: { estado: 'PENDIENTE' }, select: { tipo: true, dias: true } }),
    prisma.jobPosition.findMany({ where: { estado: { notIn: ['CERRADA'] } }, select: { dept: true, prioridad: true } }),
  ]);

  const byDept = {};
  for (const e of employees) {
    if (!byDept[e.dept]) byDept[e.dept] = { count: 0, perf: [], avgSalary: 0, lowVacations: 0 };
    byDept[e.dept].count++;
    if (e.performance) byDept[e.dept].perf.push(e.performance);
    byDept[e.dept].avgSalary += e.salario;
    if (e.vacaciones < 3) byDept[e.dept].lowVacations++;
  }

  const prompt = `Eres el People Analytics Manager de DutyJoy. Analiza la salud del equipo y genera recomendaciones.

DATOS DEL EQUIPO:
${JSON.stringify({ totalActivos: employees.length, porDepartamento: byDept, ptoPendientes: pto.length, vacantesAbiertas: positions.length })}

Responde SOLO JSON:
{
  "score_salud_general": <0-100>,
  "nivel": "excelente|bueno|en_riesgo|critico",
  "resumen": "<2-3 oraciones ejecutivas>",
  "alertas": [{"dept":"<dept o null>","tipo":"<tipo>","descripcion":"<qué está pasando>","urgencia":"alta|media"}],
  "fortalezas_equipo": ["<F1>","<F2>","<F3>"],
  "riesgos_identificados": ["<R1>","<R2>","<R3>"],
  "recomendaciones": [{"accion":"<acción concreta>","impacto":"<qué mejora>","plazo":"inmediato|corto|mediano"}],
  "metricas_clave": [{"nombre":"<métrica>","valor":"<valor actual>","semaforo":"verde|amarillo|rojo"}]
}`;

  try {
    const health = await ai(prompt, { model: 'gpt-4o', max_tokens: 1200, temp: 0.35 });
    res.json({ health, analyzedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  HR STATS
// ══════════════════════════════════════════════════════════════
router.get('/stats', verifyToken, soloAdmin, async (req, res) => {
  const [total, activos, porDept, nomina, vacantes, ptoPending, reviews] = await Promise.all([
    prisma.employee.count(),
    prisma.employee.count({ where: { estado: 'ACTIVO' } }),
    prisma.employee.groupBy({ by: ['dept'], _count: { id: true }, where: { estado: 'ACTIVO' } }),
    prisma.employee.aggregate({ _sum: { salario: true }, where: { estado: 'ACTIVO', tipo: { in: ['TIEMPO_COMPLETO','MEDIO_TIEMPO'] } } }),
    prisma.jobPosition.count({ where: { estado: { notIn: ['CERRADA'] } } }),
    prisma.ptoRequest.count({ where: { estado: 'PENDIENTE' } }),
    prisma.performanceReview.count({ where: { estado: 'completada' } }),
  ]);
  res.json({ total, activos, porDept, nomina: nomina._sum.salario || 0, vacantes, ptoPending, reviews });
});

module.exports = router;
