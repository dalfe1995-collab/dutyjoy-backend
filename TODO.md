# DutyJoy Backend — Lista de Tareas

## FASE 1: Setup del Proyecto ⬅️ EMPEZAR AQUÍ
> Objetivo: Tener el servidor corriendo con conexión a base de datos

- [ ] **1.1** Inicializar proyecto Node.js con `npm init -y`
- [ ] **1.2** Instalar dependencias base: `express`, `dotenv`, `cors`, `helmet`
- [ ] **1.3** Instalar Prisma ORM: `prisma` y `@prisma/client`
- [ ] **1.4** Crear estructura de carpetas: `src/routes`, `src/controllers`, `src/middleware`, `src/models`
- [ ] **1.5** Crear archivo `.env` con variables: `DATABASE_URL`, `JWT_SECRET`, `PORT`
- [ ] **1.6** Crear archivo `.gitignore` (incluir node_modules y .env)
- [ ] **1.7** Crear servidor Express básico en `src/index.js` con ruta GET /health
- [ ] **1.8** Inicializar Prisma con `npx prisma init`
- [ ] **1.9** Definir esquema de base de datos en `prisma/schema.prisma` (ver INSTRUCCIONES.md)
- [ ] **1.10** Correr migraciones con `npx prisma migrate dev --name init`
- [ ] **1.11** Verificar que el servidor corre con `node src/index.js`

## FASE 2: Autenticación y Usuarios
> Objetivo: Registro y login con JWT para clientes y proveedores

- [ ] **2.1** Instalar: `bcryptjs`, `jsonwebtoken`
- [ ] **2.2** Crear modelo `User` en Prisma (nombre, email, password, rol)
- [ ] **2.3** Crear `POST /auth/register` — registrar usuario con contraseña encriptada
- [ ] **2.4** Crear `POST /auth/login` — devolver token JWT
- [ ] **2.5** Crear middleware `verifyToken.js` — proteger rutas privadas
- [ ] **2.6** Crear `GET /auth/me` — devolver datos del usuario autenticado
- [ ] **2.7** Crear modelo `ProviderProfile` en Prisma (servicios, tarifa, ciudad, bio)
- [ ] **2.8** Crear `GET /providers` — listar proveedores verificados
- [ ] **2.9** Crear `GET /providers/:id` — perfil público de un proveedor
- [ ] **2.10** Crear `PUT /providers/me` — proveedor actualiza su propio perfil

## FASE 3: Servicios y Solicitudes (Bookings)
> Objetivo: Que clientes puedan solicitar servicios a proveedores

- [ ] **3.1** Crear modelo `Service` en Prisma (tipo, descripción, precio, ciudad)
- [ ] **3.2** Crear `GET /services` — buscar servicios con filtros (ciudad, tipo, precio)
- [ ] **3.3** Crear modelo `Booking` en Prisma (cliente, proveedor, servicio, estado, fecha)
- [ ] **3.4** Crear `POST /bookings` — cliente solicita un servicio
- [ ] **3.5** Crear `GET /bookings/me` — ver mis solicitudes (cliente o proveedor)
- [ ] **3.6** Crear `PATCH /bookings/:id/status` — cambiar estado (confirmado, completado, cancelado)
- [ ] **3.7** Crear modelo `Review` en Prisma (calificación 1-5, comentario)
- [ ] **3.8** Crear `POST /reviews` — cliente deja reseña después del servicio
- [ ] **3.9** Calcular y actualizar promedio de calificación en perfil del proveedor

## FASE 4: Pagos y Deploy
> Objetivo: Plataforma live en dutyjoy.com

- [ ] **4.1** Integrar MercadoPago SDK (`npm i mercadopago`)
- [ ] **4.2** Crear `POST /payments/create` — generar preferencia de pago
- [ ] **4.3** Crear `POST /payments/webhook` — recibir confirmación de pago
- [ ] **4.4** Calcular y retener comisión DutyJoy (15% por defecto)
- [ ] **4.5** Subir código a GitHub (repositorio privado)
- [ ] **4.6** Deploy en Railway.app (conectar con GitHub)
- [ ] **4.7** Configurar PostgreSQL en Railway
- [ ] **4.8** Configurar variables de entorno en Railway
- [ ] **4.9** Conectar dominio api.dutyjoy.com al backend

---
*Última actualización: Fase 1 en progreso*
*Proyecto: DutyJoy Servicios de Intermediación SAS*
