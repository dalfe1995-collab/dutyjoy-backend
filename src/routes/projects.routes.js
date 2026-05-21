/**
 * projects.routes.js — AI-powered Project Management
 * Projects · Tasks · Milestones · AI Planning · Standup · Risk · Copilot
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

const ai = async (prompt, opts = {}) => {
  if (!openai) throw new Error('OPENAI_API_KEY no configurado');
  const { model = 'gpt-4o', max_tokens = 2000, temp = 0.6, json = true } = opts;
  const r = await openai.chat.completions.create({
    model, max_tokens, temperature: temp,
    ...(json && { response_format: { type: 'json_object' } }),
    messages: [{ role: 'user', content: prompt }],
  });
  return json ? JSON.parse(r.choices[0].message.content) : r.choices[0].message.content;
};

// Auto-recalculate project progress from tasks
async function recalcProgress(projectId) {
  const tasks = await prisma.projectTask.findMany({ where: { projectId }, select: { columna: true } });
  if (!tasks.length) return;
  const done = tasks.filter(t => t.columna === 'done').length;
  await prisma.project.update({ where: { id: projectId }, data: { progreso: Math.round((done / tasks.length) * 100) } });
}

// ══════════════════════════════════════════════════════════════
//  PROJECTS CRUD
// ══════════════════════════════════════════════════════════════
router.get('/', verifyToken, soloAdmin, async (req, res) => {
  const { estado, tipo, search, page = 1, limit = 50 } = req.query;
  const where = {
    ...(estado && estado !== 'todos' && { estado }),
    ...(tipo   && tipo   !== 'todos' && { tipo }),
    ...(search && { OR: [{ nombre: { contains: search, mode:'insensitive' } }, { descripcion: { contains: search, mode:'insensitive' } }] }),
  };
  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      orderBy: [{ prioridad: 'asc' }, { updatedAt: 'desc' }],
      skip: (parseInt(page)-1) * parseInt(limit),
      take: parseInt(limit),
      include: {
        _count: { select: { tasks: true, milestones: true } },
        milestones: { where: { estado: 'pendiente' }, orderBy: { fecha:'asc' }, take: 1 },
      },
    }),
    prisma.project.count({ where }),
  ]);
  res.json({ projects, total });
});

router.get('/:id', verifyToken, soloAdmin, async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      tasks:      { orderBy: [{ columna: 'asc' }, { orden: 'asc' }, { createdAt: 'asc' }] },
      milestones: { orderBy: { fecha: 'asc' } },
      comments:   { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' });
  res.json(project);
});

router.post('/', verifyToken, soloAdmin, async (req, res) => {
  const { nombre, descripcion, tipo, prioridad, fechaInicio, fechaFin, presupuesto, owner, equipo, tags, color } = req.body;
  if (!nombre) return res.status(400).json({ error: 'nombre requerido' });
  const project = await prisma.project.create({
    data: {
      nombre, descripcion, tipo: tipo||'interno', prioridad: prioridad||'media',
      fechaInicio: fechaInicio ? new Date(fechaInicio) : null,
      fechaFin:    fechaFin    ? new Date(fechaFin)    : null,
      presupuesto: presupuesto ? parseFloat(presupuesto) : null,
      owner, equipo: equipo||[], tags: tags||[], color: color||'#0ABFBC',
    },
  });
  res.status(201).json({ ok: true, project });
});

router.patch('/:id', verifyToken, soloAdmin, async (req, res) => {
  const allowed = ['nombre','descripcion','estado','prioridad','tipo','fechaInicio','fechaFin','presupuesto','owner','equipo','tags','color','progreso','aiSummary'];
  const data = Object.fromEntries(Object.entries(req.body).filter(([k])=>allowed.includes(k)));
  if (data.fechaInicio) data.fechaInicio = new Date(data.fechaInicio);
  if (data.fechaFin)    data.fechaFin    = new Date(data.fechaFin);
  if (data.presupuesto) data.presupuesto = parseFloat(data.presupuesto);
  const project = await prisma.project.update({ where: { id: req.params.id }, data });
  res.json({ ok: true, project });
});

router.delete('/:id', verifyToken, soloAdmin, async (req, res) => {
  await prisma.project.update({ where: { id: req.params.id }, data: { estado: 'cancelado' } });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
//  TASKS CRUD
// ══════════════════════════════════════════════════════════════
router.get('/:id/tasks', verifyToken, soloAdmin, async (req, res) => {
  const tasks = await prisma.projectTask.findMany({
    where: { projectId: req.params.id },
    orderBy: [{ columna:'asc' }, { orden:'asc' }, { createdAt:'asc' }],
  });
  res.json({ tasks });
});

router.post('/:id/tasks', verifyToken, soloAdmin, async (req, res) => {
  const { titulo, descripcion, columna, prioridad, asignado, puntos, etiquetas, fechaVence, estimacion } = req.body;
  if (!titulo) return res.status(400).json({ error: 'titulo requerido' });
  const task = await prisma.projectTask.create({
    data: {
      projectId: req.params.id,
      titulo, descripcion, columna: columna||'backlog', prioridad: prioridad||'media',
      asignado, puntos: puntos ? parseInt(puntos) : null,
      etiquetas: etiquetas||[], estimacion,
      fechaVence: fechaVence ? new Date(fechaVence) : null,
    },
  });
  await recalcProgress(req.params.id);
  res.status(201).json({ ok: true, task });
});

router.patch('/tasks/:taskId', verifyToken, soloAdmin, async (req, res) => {
  const allowed = ['titulo','descripcion','columna','prioridad','asignado','puntos','etiquetas','fechaVence','estimacion','subtareas','aiNotas','orden','bloqueadoPor','dependencias'];
  const data = Object.fromEntries(Object.entries(req.body).filter(([k])=>allowed.includes(k)));
  if (data.fechaVence) data.fechaVence = new Date(data.fechaVence);
  if (data.puntos) data.puntos = parseInt(data.puntos);
  const task = await prisma.projectTask.update({ where: { id: req.params.taskId }, data });
  await recalcProgress(task.projectId);
  res.json({ ok: true, task });
});

router.delete('/tasks/:taskId', verifyToken, soloAdmin, async (req, res) => {
  const task = await prisma.projectTask.delete({ where: { id: req.params.taskId } });
  await recalcProgress(task.projectId);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
//  MILESTONES CRUD
// ══════════════════════════════════════════════════════════════
router.post('/:id/milestones', verifyToken, soloAdmin, async (req, res) => {
  const { nombre, fecha, descripcion } = req.body;
  if (!nombre || !fecha) return res.status(400).json({ error: 'nombre y fecha requeridos' });
  const ms = await prisma.projectMilestone.create({ data: { projectId: req.params.id, nombre, fecha: new Date(fecha), descripcion } });
  res.status(201).json({ ok: true, milestone: ms });
});

router.patch('/milestones/:msId', verifyToken, soloAdmin, async (req, res) => {
  const ms = await prisma.projectMilestone.update({ where: { id: req.params.msId }, data: req.body });
  res.json({ ok: true, milestone: ms });
});

// ══════════════════════════════════════════════════════════════
//  COMMENTS
// ══════════════════════════════════════════════════════════════
router.post('/:id/comments', verifyToken, soloAdmin, async (req, res) => {
  const { contenido, tipo } = req.body;
  if (!contenido) return res.status(400).json({ error: 'contenido requerido' });
  const comment = await prisma.projectComment.create({
    data: { projectId: req.params.id, autor: req.user.email || 'Admin', contenido, tipo: tipo||'comentario' },
  });
  res.status(201).json({ ok: true, comment });
});

// ══════════════════════════════════════════════════════════════
//  AI — FULL PROJECT PLANNER
// ══════════════════════════════════════════════════════════════
router.post('/ai/plan', verifyToken, soloAdmin, async (req, res) => {
  const {
    nombre, descripcion, objetivo, equipo = [], presupuesto, duracionSemanas = 8,
    tipo = 'producto', restricciones = '', metodologia = 'agile',
  } = req.body;
  if (!nombre || !objetivo) return res.status(400).json({ error: 'nombre y objetivo requeridos' });

  // Pull team context
  const employees = await prisma.employee.findMany({ where: { estado:'ACTIVO' }, select: { nombre:true, cargo:true, dept:true, skills:true } }).catch(()=>[]);
  const teamContext = equipo.length ? equipo.join(', ') : employees.slice(0,6).map(e=>`${e.nombre} (${e.cargo})`).join(', ');

  const prompt = `Eres el Project Manager IA de DutyJoy, startup colombiana de servicios del hogar.
Genera un plan de proyecto COMPLETO y ACCIONABLE.

PROYECTO: ${nombre}
OBJETIVO: ${objetivo}
DESCRIPCIÓN: ${descripcion || '—'}
TIPO: ${tipo}
METODOLOGÍA: ${metodologia}
DURACIÓN ESTIMADA: ${duracionSemanas} semanas
PRESUPUESTO: ${presupuesto ? `$${Number(presupuesto).toLocaleString('es-CO')} COP` : 'Por definir'}
EQUIPO DISPONIBLE: ${teamContext || 'Por definir'}
RESTRICCIONES: ${restricciones || 'Ninguna especificada'}

Genera un plan ejecutivo detallado. Sé específico, no genérico.

Responde SOLO JSON:
{
  "resumen_ejecutivo": "<3-4 oraciones que describen el proyecto, su valor y su alcance>",
  "objetivos_smart": [
    {"objetivo": "<objetivo SMART>", "metrica": "<cómo medirlo>", "plazo": "<cuándo>"}
  ],
  "alcance": {
    "incluido": ["<item 1>","<item 2>","<item 3>","<item 4>","<item 5>"],
    "excluido": ["<item 1>","<item 2>","<item 3>"]
  },
  "fases": [
    {
      "numero": 1,
      "nombre": "<nombre de la fase>",
      "duracion_semanas": <number>,
      "objetivos": ["<obj 1>","<obj 2>"],
      "entregables": ["<entregable 1>","<entregable 2>"],
      "tareas": [
        {
          "titulo": "<tarea concreta>",
          "descripcion": "<qué implica>",
          "columna": "backlog",
          "prioridad": "alta|media|baja",
          "puntos": <1-13>,
          "asignado": "<nombre del responsable>",
          "etiquetas": ["<tag>"],
          "estimacion": "<horas o días>"
        }
      ]
    }
  ],
  "milestones": [
    {"nombre": "<hito>", "semana": <number>, "descripcion": "<qué debe estar listo>", "criterio_exito": "<cómo saber que se logró>"}
  ],
  "recursos": {
    "humanos": [{"rol": "<rol>", "dedicacion": "<% o horas/semana>", "perfil": "<qué skills necesita>"}],
    "tecnicos": ["<herramienta/recurso 1>","<herramienta 2>"],
    "presupuesto_desglose": [{"categoria": "<cat>","monto_cop": <number>,"justificacion": "<por qué>"}]
  },
  "riesgos_iniciales": [
    {"riesgo": "<riesgo>","probabilidad": "alta|media|baja","impacto": "alto|medio|bajo","mitigacion": "<cómo mitigar>"}
  ],
  "kpis_proyecto": [
    {"nombre": "<KPI>","valor_objetivo": "<target>","frecuencia_medicion": "<semanal|mensual>"}
  ],
  "dependencias_externas": ["<dep 1>","<dep 2>"],
  "definition_of_done": ["<criterio 1>","<criterio 2>","<criterio 3>","<criterio 4>"],
  "comunicacion": {
    "standup": "<frecuencia y formato>",
    "reporte_progreso": "<a quién, cuándo>",
    "decision_making": "<proceso de toma de decisiones>"
  },
  "cronograma_resumen": "<descripción del cronograma semana a semana en 3-4 oraciones>"
}`;

  try {
    const plan = await ai(prompt, { model:'gpt-4o', max_tokens:3500, temp:0.6 });

    // Create project in DB
    const startDate = new Date();
    const endDate   = new Date(Date.now() + duracionSemanas * 7 * 86400000);

    const project = await prisma.project.create({
      data: {
        nombre, descripcion: descripcion || objetivo, tipo,
        prioridad: 'alta', estado: 'planificacion',
        fechaInicio: startDate, fechaFin: endDate,
        presupuesto: presupuesto ? parseFloat(presupuesto) : null,
        equipo: equipo.length ? equipo : [],
        aiPlan: plan,
        aiSummary: plan.resumen_ejecutivo,
      },
    });

    // Create all tasks from all phases
    let orden = 0;
    for (const fase of (plan.fases || [])) {
      for (const tarea of (fase.tareas || [])) {
        await prisma.projectTask.create({
          data: {
            projectId: project.id,
            titulo: tarea.titulo,
            descripcion: tarea.descripcion,
            columna: 'backlog',
            prioridad: tarea.prioridad || 'media',
            puntos: tarea.puntos || null,
            asignado: tarea.asignado || null,
            etiquetas: tarea.etiquetas || [],
            estimacion: tarea.estimacion || null,
            orden: orden++,
            aiNotas: `Fase ${fase.numero}: ${fase.nombre}`,
          },
        });
      }
    }

    // Create milestones
    for (const ms of (plan.milestones || [])) {
      const msDate = new Date(Date.now() + (ms.semana || 4) * 7 * 86400000);
      await prisma.projectMilestone.create({
        data: { projectId: project.id, nombre: ms.nombre, fecha: msDate, descripcion: ms.descripcion },
      });
    }

    res.json({ plan, projectId: project.id, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[projects/ai/plan]', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — TASK BREAKDOWN
// ══════════════════════════════════════════════════════════════
router.post('/ai/breakdown', verifyToken, soloAdmin, async (req, res) => {
  const { taskId, titulo, descripcion, contexto = '' } = req.body;
  if (!titulo) return res.status(400).json({ error: 'titulo requerido' });

  const prompt = `Eres PM de DutyJoy. Desglosa esta tarea en subtareas concretas y accionables.

TAREA: ${titulo}
DESCRIPCIÓN: ${descripcion || '—'}
CONTEXTO: ${contexto || 'Proyecto DutyJoy'}

Devuelve subtareas específicas que un desarrollador o responsable pueda ejecutar sin ambigüedad.

Responde SOLO JSON:
{
  "subtareas": [
    {"id":"st-1","texto":"<subtarea concreta>","done":false,"estimacion":"<tiempo>","notas":"<detalles si aplica>"}
  ],
  "estimacion_total": "<tiempo total estimado>",
  "puntos_sugeridos": <1-13>,
  "criterio_completitud": "<cómo saber que la tarea está 100% terminada>",
  "dependencias_sugeridas": ["<qué debe estar hecho antes>"],
  "riesgos_tarea": ["<riesgo específico de esta tarea>"]
}`;

  try {
    const breakdown = await ai(prompt, { max_tokens:1000, temp:0.5 });

    if (taskId) {
      await prisma.projectTask.update({
        where: { id: taskId },
        data: { subtareas: breakdown.subtareas, estimacion: breakdown.estimacion_total, puntos: breakdown.puntos_sugeridos },
      });
    }

    res.json({ breakdown, taskId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — RISK ANALYSIS
// ══════════════════════════════════════════════════════════════
router.post('/ai/risk-analysis', verifyToken, soloAdmin, async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId requerido' });

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { tasks: true, milestones: true },
  });
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' });

  const overdueTasks = project.tasks.filter(t => t.fechaVence && new Date(t.fechaVence) < new Date() && t.columna !== 'done').length;
  const blockedTasks = project.tasks.filter(t => t.columna === 'blocked').length;
  const donePct      = project.tasks.length ? Math.round(project.tasks.filter(t=>t.columna==='done').length / project.tasks.length * 100) : 0;
  const daysLeft     = project.fechaFin ? Math.ceil((new Date(project.fechaFin)-Date.now())/86400000) : null;

  const prompt = `Eres PM senior de DutyJoy. Analiza los riesgos de este proyecto y genera un risk register.

PROYECTO: ${project.nombre}
ESTADO: ${project.estado} | PROGRESO: ${donePct}%
TAREAS BLOQUEADAS: ${blockedTasks} | TAREAS VENCIDAS: ${overdueTasks}
DÍAS RESTANTES: ${daysLeft ?? 'sin fecha fin'} | TAREAS TOTALES: ${project.tasks.length}
EQUIPO: ${project.equipo?.join(', ') || 'No definido'}
DESCRIPCIÓN: ${project.descripcion || '—'}

Responde SOLO JSON:
{
  "score_salud": <0-100>,
  "nivel_riesgo_general": "bajo|medio|alto|critico",
  "resumen": "<2-3 oraciones ejecutivas sobre el estado de riesgo>",
  "riesgos": [
    {
      "id": "R-01",
      "categoria": "cronograma|presupuesto|tecnico|recursos|alcance|externo",
      "titulo": "<nombre corto del riesgo>",
      "descripcion": "<descripción detallada>",
      "probabilidad": "alta|media|baja",
      "impacto": "alto|medio|bajo",
      "score": <1-25>,
      "indicadores": ["<señal de alerta 1>","<señal 2>"],
      "mitigacion": "<plan concreto para mitigar>",
      "contingencia": "<qué hacer si el riesgo se materializa>",
      "owner": "<quién es responsable de vigilar este riesgo>",
      "estado": "activo|en_mitigacion|resuelto"
    }
  ],
  "alertas_inmediatas": ["<alerta urgente 1>","<alerta 2>"],
  "acciones_prioritarias": [
    {"accion": "<qué hacer>","plazo": "<cuándo>","responsable": "<quién>","urgencia": "inmediata|esta_semana|este_mes"}
  ],
  "probabilidad_exito": <0-100>,
  "recomendacion_pm": "<consejo principal para el PM>"
}`;

  try {
    const risks = await ai(prompt, { model:'gpt-4o', max_tokens:2000, temp:0.35 });

    await prisma.project.update({
      where: { id: projectId },
      data: { aiRisks: risks, progreso: donePct },
    });

    res.json({ risks, projectId, analyzedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — STANDUP GENERATOR
// ══════════════════════════════════════════════════════════════
router.post('/ai/standup', verifyToken, soloAdmin, async (req, res) => {
  const { projectIds = [] } = req.body;

  const projects = await prisma.project.findMany({
    where: { estado: 'activo', ...(projectIds.length && { id: { in: projectIds } }) },
    include: {
      tasks: { where: { columna: { in: ['in_progress','blocked','review'] } }, orderBy: { updatedAt:'desc' } },
      milestones: { where: { estado: { in: ['pendiente','en_riesgo'] }, fecha: { gte: new Date() } }, orderBy: { fecha:'asc' }, take: 2 },
    },
    take: 10,
  });

  if (!projects.length) return res.json({ standup: null, message: 'No hay proyectos activos' });

  const summary = projects.map(p => ({
    proyecto: p.nombre,
    progreso: p.progreso,
    en_progreso: p.tasks.filter(t=>t.columna==='in_progress').map(t=>`[${t.asignado||'Sin asignar'}] ${t.titulo}`),
    bloqueados:  p.tasks.filter(t=>t.columna==='blocked').map(t=>`${t.titulo}: ${t.bloqueadoPor||'Sin detalle'}`),
    en_revision: p.tasks.filter(t=>t.columna==='review').map(t=>t.titulo),
    proximos_milestones: p.milestones.map(m=>`${m.nombre} (${new Date(m.fecha).toLocaleDateString('es-CO',{day:'2-digit',month:'short'})})`),
  }));

  const prompt = `Eres el PM de DutyJoy. Genera el reporte de standup diario para el equipo.
Hoy: ${new Date().toLocaleDateString('es-CO',{ weekday:'long', day:'numeric', month:'long' })}

ESTADO ACTUAL DE PROYECTOS:
${JSON.stringify(summary, null, 2)}

Genera un standup conciso pero completo. Resalta lo urgente. Tone: directo y enfocado.

Responde SOLO JSON:
{
  "fecha": "${new Date().toLocaleDateString('es-CO',{weekday:'long',day:'numeric',month:'long'})}",
  "resumen_general": "<1-2 oraciones del estado general>",
  "por_proyecto": [
    {
      "proyecto": "<nombre>",
      "progreso": <pct>,
      "ayer": ["<qué se hizo>"],
      "hoy": ["<qué se va a hacer>"],
      "bloqueadores": ["<bloqueador si aplica>"],
      "semaforo": "verde|amarillo|rojo"
    }
  ],
  "bloqueadores_criticos": ["<bloqueador urgente 1>","<bloqueador 2>"],
  "milestones_proximos": ["<hito en los próximos 7 días>"],
  "decision_requerida": "<si hay algo que el equipo necesita decidir hoy>",
  "mensaje_motivacional": "<mensaje corto y genuino para el equipo, no clichés>",
  "foco_del_dia": "<el UNA cosa más importante que el equipo debe lograr hoy>"
}`;

  try {
    const standup = await ai(prompt, { max_tokens:1200, temp:0.55 });
    res.json({ standup, projectCount: projects.length, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — STATUS REPORT (executive)
// ══════════════════════════════════════════════════════════════
router.post('/ai/status-report', verifyToken, soloAdmin, async (req, res) => {
  const { projectId, audiencia = 'ceo' } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId requerido' });

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { tasks: true, milestones: true, comments: { orderBy: { createdAt:'desc' }, take:5 } },
  });
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' });

  const stats = {
    total: project.tasks.length,
    done: project.tasks.filter(t=>t.columna==='done').length,
    inProgress: project.tasks.filter(t=>t.columna==='in_progress').length,
    blocked: project.tasks.filter(t=>t.columna==='blocked').length,
    backlog: project.tasks.filter(t=>t.columna==='backlog').length,
    overdue: project.tasks.filter(t=>t.fechaVence && new Date(t.fechaVence)<new Date() && t.columna!=='done').length,
  };
  const daysLeft = project.fechaFin ? Math.ceil((new Date(project.fechaFin)-Date.now())/86400000) : null;

  const prompt = `Eres el PM de DutyJoy escribiendo un reporte de estado del proyecto para: ${audiencia.toUpperCase()}.

PROYECTO: ${project.nombre}
FECHA: ${new Date().toLocaleDateString('es-CO',{day:'numeric',month:'long',year:'numeric'})}
ESTADO: ${project.estado} | PROGRESO: ${project.progreso}%
DÍAS RESTANTES: ${daysLeft ?? 'sin fecha definida'}
TAREAS: ${stats.done}/${stats.total} completadas | ${stats.blocked} bloqueadas | ${stats.overdue} vencidas
MILESTONES: ${project.milestones.length} en total

El reporte debe ser apropiado para ${audiencia} — ${audiencia==='ceo'?'ejecutivo, alto nivel, enfocado en resultados y riesgos':'técnico, detallado, con detalles de implementación'}.

Responde SOLO JSON:
{
  "titulo": "<título del reporte>",
  "fecha": "${new Date().toLocaleDateString('es-CO')}",
  "estado_semaforo": "verde|amarillo|rojo",
  "resumen_ejecutivo": "<3-5 oraciones directas al punto>",
  "progreso": {
    "pct_completado": ${project.progreso},
    "narrativa": "<descripción del progreso en 2-3 oraciones>",
    "logros_periodo": ["<logro 1>","<logro 2>","<logro 3>"]
  },
  "cronograma": {
    "en_tiempo": ${daysLeft === null || daysLeft > 0 ? 'true' : 'false'},
    "dias_restantes": ${daysLeft ?? 'null'},
    "proyeccion": "<si va en tiempo, atrasado o adelantado>"
  },
  "problemas_activos": [
    {"problema": "<problema>","impacto": "<en qué afecta>","plan_resolucion": "<cómo se resuelve>"}
  ],
  "proximos_pasos": ["<siguiente acción 1>","<acción 2>","<acción 3>"],
  "metricas": [{"nombre":"<métrica>","valor":"<valor>","tendencia":"mejora|estable|empeora"}],
  "decisiones_requeridas": ["<decisión que necesita el patrocinador>"],
  "mensaje_final": "<1 oración de cierre con el tono apropiado>"
}`;

  try {
    const report = await ai(prompt, { model:'gpt-4o', max_tokens:1800, temp:0.5 });

    // Save as comment
    await prisma.projectComment.create({
      data: { projectId, autor:'IA', contenido:`[Reporte de estado IA — ${audiencia}]: ${report.resumen_ejecutivo}`, tipo:'ai_insight' },
    });

    res.json({ report, projectId, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — RETROSPECTIVE FACILITATOR
// ══════════════════════════════════════════════════════════════
router.post('/ai/retrospective', verifyToken, soloAdmin, async (req, res) => {
  const { projectId, periodo = 'sprint', notas = '' } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId requerido' });

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { tasks: { where: { updatedAt: { gte: new Date(Date.now() - 14*86400000) } } }, milestones: true },
  });

  const doneRecent   = project?.tasks.filter(t=>t.columna==='done').length || 0;
  const blockedCount = project?.tasks.filter(t=>t.columna==='blocked').length || 0;

  const prompt = `Eres PM facilitador de retrospectivas de DutyJoy.
Facilita una retrospectiva del ${periodo} para el proyecto "${project?.nombre || 'DutyJoy'}".

CONTEXTO:
- Tareas completadas recientemente: ${doneRecent}
- Tareas bloqueadas: ${blockedCount}
- Progreso general: ${project?.progreso || 0}%
- Notas del equipo: ${notas || 'Ninguna proporcionada'}

Genera una retrospectiva usando el formato "Mad, Sad, Glad" + "Lessons Learned".

Responde SOLO JSON:
{
  "formato": "Mad-Sad-Glad",
  "glad": {
    "titulo": "✅ Lo que salió bien",
    "items": ["<logro o práctica positiva 1>","<logro 2>","<logro 3>","<logro 4>"]
  },
  "sad": {
    "titulo": "😔 Lo que no salió bien",
    "items": ["<problema 1>","<problema 2>","<problema 3>"]
  },
  "mad": {
    "titulo": "😤 Lo que nos frustró",
    "items": ["<frustración 1>","<frustración 2>"]
  },
  "lecciones_aprendidas": ["<lección concreta 1>","<lección 2>","<lección 3>"],
  "acciones_mejora": [
    {"accion": "<acción concreta>","owner": "<quién>","plazo": "<cuándo>","tipo": "proceso|tecnico|comunicacion|cultura"}
  ],
  "compromisos_proximo_periodo": ["<compromiso 1>","<compromiso 2>","<compromiso 3>"],
  "preguntas_reflexion": ["<pregunta para el equipo 1>","<pregunta 2>","<pregunta 3>"],
  "health_score": <0-10>,
  "mensaje_cierre": "<mensaje motivador de cierre de la retro>"
}`;

  try {
    const retro = await ai(prompt, { max_tokens:1500, temp:0.65 });

    await prisma.projectComment.create({
      data: { projectId, autor:'IA — Retrospectiva', contenido: `Retrospectiva ${periodo}: ${retro.glad.items[0]}... Score: ${retro.health_score}/10`, tipo:'ai_insight' },
    });

    res.json({ retro, projectId, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — TASK ESTIMATOR
// ══════════════════════════════════════════════════════════════
router.post('/ai/estimate', verifyToken, soloAdmin, async (req, res) => {
  const { titulo, descripcion, contexto = '', equipo = [] } = req.body;
  if (!titulo) return res.status(400).json({ error: 'titulo requerido' });

  const prompt = `Eres PM y tech lead de DutyJoy (stack: React + Node.js + Prisma + PostgreSQL).
Estima el esfuerzo de esta tarea usando Planning Poker (Fibonacci) y tres estimaciones (optimista, realista, pesimista).

TAREA: ${titulo}
DESCRIPCIÓN: ${descripcion || '—'}
CONTEXTO: ${contexto || 'Stack DutyJoy estándar'}
EQUIPO: ${equipo.join(', ') || 'Equipo DutyJoy'}

Responde SOLO JSON:
{
  "puntos_fibonacci": <1|2|3|5|8|13|21>,
  "horas": {
    "optimista": <number>,
    "realista": <number>,
    "pesimista": <number>,
    "expected": <number>
  },
  "complejidad": "trivial|simple|media|compleja|muy_compleja",
  "incertidumbre": "baja|media|alta|muy_alta",
  "riesgos_estimacion": ["<riesgo que podría hacer que tome más tiempo>"],
  "supuestos": ["<supuesto 1 en el que basa la estimación>","<supuesto 2>"],
  "subtareas_estimadas": [
    {"subtarea": "<componente de trabajo>","horas": <number>,"skills_requeridos": ["<skill>"]}
  ],
  "recomendacion": "<consejo del PM sobre cómo abordar esta tarea>",
  "preparacion_necesaria": ["<qué debe estar listo antes de empezar>"]
}`;

  try {
    const estimate = await ai(prompt, { max_tokens:1000, temp:0.4 });
    res.json({ estimate, titulo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — UNBLOCK ASSISTANT
// ══════════════════════════════════════════════════════════════
router.post('/ai/unblock', verifyToken, soloAdmin, async (req, res) => {
  const { taskId, bloqueador, contexto = '' } = req.body;
  if (!bloqueador) return res.status(400).json({ error: 'bloqueador requerido' });

  const task = taskId ? await prisma.projectTask.findUnique({ where: { id: taskId } }) : null;

  const prompt = `Eres PM coach de DutyJoy. Ayuda a desbloquear esta situación.

TAREA BLOQUEADA: ${task?.titulo || 'Sin tarea específica'}
BLOQUEADOR: ${bloqueador}
CONTEXTO ADICIONAL: ${contexto || 'Proyecto DutyJoy, stack React + Node.js + Prisma'}

Proporciona opciones concretas y accionables para desbloquear.

Responde SOLO JSON:
{
  "diagnostico": "<qué tipo de bloqueador es y por qué ocurre>",
  "opciones": [
    {
      "opcion": "<nombre de la opción>",
      "descripcion": "<cómo implementarla>",
      "pros": ["<ventaja 1>","<ventaja 2>"],
      "contras": ["<desventaja>"],
      "tiempo_implementacion": "<estimado>",
      "recomendada": true|false
    }
  ],
  "accion_inmediata": "<qué hacer AHORA mismo, en los próximos 30 minutos>",
  "a_quien_escalar": "<si necesita escalarse, a quién y cómo plantearlo>",
  "workaround_temporal": "<si hay un workaround que permita avanzar mientras se resuelve>",
  "prevencion_futura": "<cómo evitar este bloqueador en el futuro>"
}`;

  try {
    const solution = await ai(prompt, { max_tokens:1200, temp:0.55 });

    if (taskId && task) {
      await prisma.projectTask.update({
        where: { id: taskId },
        data: { aiNotas: `Desbloqueo sugerido: ${solution.accion_inmediata}` },
      });
    }

    res.json({ solution, taskId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — RESOURCE ALLOCATION
// ══════════════════════════════════════════════════════════════
router.post('/ai/resource-allocation', verifyToken, soloAdmin, async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId requerido' });

  const [project, employees] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, include: { tasks: { where: { columna: { notIn: ['done'] } } } } }),
    prisma.employee.findMany({ where: { estado:'ACTIVO' }, select: { nombre:true, cargo:true, dept:true, skills:true, nivelSalarial:true } }),
  ]);

  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' });

  const prompt = `Eres PM de DutyJoy. Sugiere la asignación óptima de recursos para este proyecto.

PROYECTO: ${project.nombre}
TAREAS SIN ASIGNAR O EN PROGRESO: ${project.tasks.length}
TAREAS DETALLE: ${JSON.stringify(project.tasks.map(t=>({titulo:t.titulo,prioridad:t.prioridad,estimacion:t.estimacion,etiquetas:t.etiquetas})))}

EQUIPO DISPONIBLE:
${JSON.stringify(employees.map(e=>({nombre:e.nombre,cargo:e.cargo,skills:e.skills,nivel:e.nivelSalarial})))}

Haz asignaciones óptimas considerando skills, carga de trabajo y prioridades.

Responde SOLO JSON:
{
  "asignaciones": [
    {
      "empleado": "<nombre>",
      "tareas": ["<titulo tarea 1>","<titulo tarea 2>"],
      "dedicacion_pct": <number>,
      "horas_semana": <number>,
      "justificacion": "<por qué esta persona para estas tareas>",
      "riesgo_sobrecarga": "bajo|medio|alto"
    }
  ],
  "gaps_identificados": ["<skill que falta en el equipo>","<gap 2>"],
  "advertencias": ["<advertencia sobre la asignación>"],
  "carga_total_equipo": {"horas_semana_total": <number>,"personas_involucradas": <number>},
  "recomendacion_gestion": "<consejo sobre cómo gestionar al equipo en este proyecto>"
}`;

  try {
    const allocation = await ai(prompt, { max_tokens:1500, temp:0.5 });
    res.json({ allocation, projectId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AI — PM COPILOT
// ══════════════════════════════════════════════════════════════
router.post('/ai/copilot', verifyToken, soloAdmin, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY requerido' });

  const { messages: history = [], pregunta, projectId } = req.body;
  if (!pregunta) return res.status(400).json({ error: 'pregunta requerida' });

  let projectContext = '';
  if (projectId) {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      include: { tasks: { orderBy: { updatedAt:'desc' }, take: 10 }, milestones: { orderBy: { fecha:'asc' }, take:3 } },
    }).catch(()=>null);
    if (p) {
      const done = p.tasks.filter(t=>t.columna==='done').length;
      projectContext = `\nPROYECTO ACTIVO: ${p.nombre} (${p.progreso}% completado, ${done}/${p.tasks.length} tareas done, ${p.tasks.filter(t=>t.columna==='blocked').length} bloqueadas)`;
    }
  }

  const [projectCount, activeProjects] = await Promise.all([
    prisma.project.count(),
    prisma.project.count({ where: { estado:'activo' } }),
  ]).catch(()=>[0,0]);

  const systemPrompt = `Eres el PM Copilot IA de DutyJoy, especialista en gestión de proyectos.

CONTEXTO:
- ${projectCount} proyectos total, ${activeProjects} activos${projectContext}
- Metodología: Agile/Scrum adaptado para startup
- Stack: React + Node.js + Prisma + Railway

ESPECIALIDADES: Planificación, estimación, gestión de riesgos, facilitación de standups/retros, desbloqueadores, comunicación con stakeholders, priorización, gestión de scope, OKRs.

TONO: Directo, práctico, sin teoría innecesaria. Da respuestas accionables. Español colombiano.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o', max_tokens: 900, temperature: 0.55,
      messages: [
        { role:'system', content:systemPrompt },
        ...history.slice(-8).map(m=>({ role:m.role, content:m.content })),
        { role:'user', content:pregunta },
      ],
    });
    res.json({ respuesta: completion.choices[0].message.content, role:'assistant', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════════
router.get('/stats/summary', verifyToken, soloAdmin, async (req, res) => {
  const [total, activos, completados, tasks, overdueTasks] = await Promise.all([
    prisma.project.count(),
    prisma.project.count({ where: { estado:'activo' } }),
    prisma.project.count({ where: { estado:'completado' } }),
    prisma.projectTask.groupBy({ by:['columna'], _count:{ id:true } }),
    prisma.projectTask.count({ where: { fechaVence: { lt: new Date() }, columna: { notIn:['done'] } } }),
  ]);
  const tasksByCol = Object.fromEntries(tasks.map(t=>[t.columna, t._count.id]));
  res.json({ total, activos, completados, tasksByCol, overdueTasks });
});

module.exports = router;
