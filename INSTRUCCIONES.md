# INSTRUCCIONES PARA CLAUDE CODE — DutyJoy Backend Fase 1

> **IMPORTANTE:** Lee este archivo completo antes de ejecutar cualquier comando.
> Eres el asistente de desarrollo de DutyJoy, una plataforma colombiana de
> servicios domésticos y profesionales. Sigue estas instrucciones en orden.

---

## CONTEXTO DEL PROYECTO

**Empresa:** DutyJoy Servicios de Intermediación SAS
**Modelo:** Marketplace que conecta clientes con proveedores de servicios del hogar
**Ciudad inicial:** Ibagué y Bogotá, Colombia
**Stack:** Node.js + Express + PostgreSQL (Prisma ORM)
**Moneda:** Pesos colombianos (COP)
**Comisión plataforma:** 15% por transacción

---

## PASO 1 — Inicializar el proyecto

Ejecuta estos comandos en orden:

```bash
npm init -y
npm install express dotenv cors helmet morgan
npm install prisma @prisma/client --save-dev
npm install bcryptjs jsonwebtoken
npm install --save-dev nodemon
```

Luego modifica `package.json` y agrega estos scripts:
```json
"scripts": {
  "dev": "nodemon src/index.js",
  "start": "node src/index.js",
  "db:migrate": "npx prisma migrate dev",
  "db:studio": "npx prisma studio"
}
```

---

## PASO 2 — Estructura de carpetas

Crea exactamente esta estructura:

```
dutyjoy-backend/
├── src/
│   ├── index.js
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── providers.routes.js
│   │   ├── services.routes.js
│   │   └── bookings.routes.js
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── providers.controller.js
│   │   └── bookings.controller.js
│   └── middleware/
│       ├── verifyToken.js
│       └── errorHandler.js
├── prisma/
│   └── schema.prisma
├── .env
├── .gitignore
└── TODO.md
```

---

## PASO 3 — Archivo .env

Crea el archivo `.env` con este contenido exacto:

```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/dutyjoy_db"
JWT_SECRET="dutyjoy_secret_super_seguro_cambiar_en_produccion"
PORT=3000
NODE_ENV=development
COMMISSION_RATE=0.15
```

> NOTA: El usuario deberá cambiar DATABASE_URL con sus credenciales reales de PostgreSQL.

---

## PASO 4 — Archivo .gitignore

```
node_modules/
.env
.env.local
dist/
*.log
```

---

## PASO 5 — Servidor Express principal (src/index.js)

```javascript
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

const app = express();

// Middlewares
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Rutas
app.use('/auth', require('./routes/auth.routes'));
app.use('/providers', require('./routes/providers.routes'));
app.use('/services', require('./routes/services.routes'));
app.use('/bookings', require('./routes/bookings.routes'));

// Ruta de salud — verificar que el servidor está vivo
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    project: 'DutyJoy Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DutyJoy API corriendo en http://localhost:${PORT}`);
  console.log(`Verificar salud: GET http://localhost:${PORT}/health`);
});
```

---

## PASO 6 — Esquema de base de datos (prisma/schema.prisma)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(cuid())
  nombre    String
  email     String   @unique
  password  String
  telefono  String?
  ciudad    String   @default("Ibagué")
  rol       Rol      @default(CLIENTE)
  activo    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Relaciones
  providerProfile ProviderProfile?
  bookingsComoCliente   Booking[] @relation("ClienteBookings")
  reviewsEscritas       Review[]  @relation("ClienteReviews")
}

enum Rol {
  CLIENTE
  PROVEEDOR
  ADMIN
}

model ProviderProfile {
  id              String   @id @default(cuid())
  userId          String   @unique
  user            User     @relation(fields: [userId], references: [id])
  bio             String?
  servicios       String[] // ["aseo", "jardineria", "plomeria"]
  tarifaPorHora   Float    @default(25000) // en COP
  ciudades        String[] @default(["Ibagué"])
  calificacion    Float    @default(0)
  totalReviews    Int      @default(0)
  verificado      Boolean  @default(false)
  disponible      Boolean  @default(true)
  createdAt       DateTime @default(now())

  bookings Booking[]
  reviews  Review[]
}

model Booking {
  id           String        @id @default(cuid())
  clienteId    String
  cliente      User          @relation("ClienteBookings", fields: [clienteId], references: [id])
  proveedorId  String
  proveedor    ProviderProfile @relation(fields: [proveedorId], references: [id])
  tipoServicio String
  descripcion  String?
  fechaServicio DateTime
  duracionHoras Float        @default(2)
  precioTotal  Float
  comisionDutyJoy Float
  estado       EstadoBooking @default(PENDIENTE)
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  review Review?
}

enum EstadoBooking {
  PENDIENTE
  CONFIRMADO
  EN_PROGRESO
  COMPLETADO
  CANCELADO
}

model Review {
  id          String   @id @default(cuid())
  bookingId   String   @unique
  booking     Booking  @relation(fields: [bookingId], references: [id])
  clienteId   String
  cliente     User     @relation("ClienteReviews", fields: [clienteId], references: [id])
  proveedorId String
  proveedor   ProviderProfile @relation(fields: [proveedorId], references: [id])
  calificacion Int     // 1 a 5
  comentario  String?
  createdAt   DateTime @default(now())
}
```

---

## PASO 7 — Middleware de autenticación (src/middleware/verifyToken.js)

```javascript
const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Token inválido o expirado' });
  }
};

module.exports = verifyToken;
```

---

## PASO 8 — Rutas de autenticación (src/routes/auth.routes.js)

```javascript
const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const verifyToken = require('../middleware/verifyToken');

const prisma = new PrismaClient();

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { nombre, email, password, telefono, ciudad, rol } = req.body;

    if (!nombre || !email || !password) {
      return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Este email ya está registrado' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        nombre,
        email,
        password: hashedPassword,
        telefono,
        ciudad: ciudad || 'Ibagué',
        rol: rol === 'PROVEEDOR' ? 'PROVEEDOR' : 'CLIENTE'
      }
    });

    // Si es proveedor, crear perfil vacío automáticamente
    if (user.rol === 'PROVEEDOR') {
      await prisma.providerProfile.create({
        data: { userId: user.id }
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, rol: user.rol },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      mensaje: 'Usuario registrado exitosamente',
      token,
      usuario: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, rol: user.rol },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      usuario: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /auth/me — obtener usuario autenticado
router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { providerProfile: true }
    });
    const { password, ...userSinPassword } = user;
    res.json(userSinPassword);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

module.exports = router;
```

---

## PASO 9 — Rutas de proveedores (src/routes/providers.routes.js)

```javascript
const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const verifyToken = require('../middleware/verifyToken');

const prisma = new PrismaClient();

// GET /providers — listar proveedores disponibles
router.get('/', async (req, res) => {
  try {
    const { ciudad, servicio } = req.query;

    const providers = await prisma.providerProfile.findMany({
      where: {
        disponible: true,
        verificado: true,
        ...(ciudad && { ciudades: { has: ciudad } }),
        ...(servicio && { servicios: { has: servicio } })
      },
      include: {
        user: { select: { nombre: true, ciudad: true } }
      },
      orderBy: { calificacion: 'desc' }
    });

    res.json(providers);
  } catch (error) {
    res.status(500).json({ error: 'Error al buscar proveedores' });
  }
});

// PUT /providers/me — proveedor actualiza su perfil
router.put('/me', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'PROVEEDOR') {
      return res.status(403).json({ error: 'Solo los proveedores pueden actualizar este perfil' });
    }

    const { bio, servicios, tarifaPorHora, ciudades, disponible } = req.body;

    const profile = await prisma.providerProfile.update({
      where: { userId: req.user.id },
      data: { bio, servicios, tarifaPorHora, ciudades, disponible }
    });

    res.json({ mensaje: 'Perfil actualizado', profile });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

module.exports = router;
```

---

## PASO 10 — Archivo de rutas vacías (para que no falle el servidor)

Crea `src/routes/services.routes.js`:
```javascript
const router = require('express').Router();
router.get('/', (req, res) => res.json({ mensaje: 'Servicios — próximamente' }));
module.exports = router;
```

Crea `src/routes/bookings.routes.js`:
```javascript
const router = require('express').Router();
router.get('/', (req, res) => res.json({ mensaje: 'Bookings — próximamente' }));
module.exports = router;
```

---

## PASO 11 — Verificación final

Después de crear todos los archivos:

1. Corre `npx prisma migrate dev --name init` para crear las tablas
2. Corre `npm run dev` para iniciar el servidor
3. Verifica que `GET http://localhost:3000/health` responde OK
4. Prueba registrar un usuario con `POST http://localhost:3000/auth/register`

Si todo funciona, marca las tareas 1.1 a 1.11 como completadas en TODO.md.

---

## ENDPOINTS IMPLEMENTADOS AL TERMINAR FASE 1

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /health | Estado del servidor |
| POST | /auth/register | Registrar usuario |
| POST | /auth/login | Iniciar sesión |
| GET | /auth/me | Mi perfil (requiere token) |
| GET | /providers | Listar proveedores |
| PUT | /providers/me | Actualizar mi perfil (proveedor) |

---

*DutyJoy Servicios de Intermediación SAS*
*Socios: Juan Manuel Rojas Cartagena & Daniel Felipe Triana Sanguña*
