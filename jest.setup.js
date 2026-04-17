// Garantiza que las variables de entorno estén disponibles durante los tests
// Jest carga este archivo antes de cada suite (setupFiles en package.json)

process.env.NODE_ENV      = 'test';
process.env.JWT_SECRET    = process.env.JWT_SECRET    || 'test_secret_jest';
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '1'; // 1 ronda en tests = ultrarrápido
