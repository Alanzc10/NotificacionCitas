const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');
const moment = require('moment-timezone');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

// Configurar zona horaria de Ecuador
moment.tz.setDefault('America/Guayaquil');

// Inicializar la aplicación antes de cargar WhatsApp
const app = express();
const PORT = process.env.PORT || 3000;

// Variables globales
let whatsappClient = null;
let isWhatsAppReady = false;

// Configurar middlewares
app.use(express.json());
app.use(express.static('public'));

// Inicializar base de datos
const db = new sqlite3.Database('citas.db', (err) => {
    if (err) {
        console.error('Error conectando a la base de datos:', err.message);
    } else {
        console.log('Base de datos SQLite conectada');
    }
});

// Crear tablas (actualizada con nuevos campos)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS citas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_nombre TEXT NOT NULL,
        cliente_telefono TEXT NOT NULL,
        fecha_cita DATETIME NOT NULL,
        servicio TEXT NOT NULL,
        servicios_adicionales TEXT,
        precio_servicio DECIMAL(10,2) DEFAULT 0,
        notas TEXT,
        estado TEXT DEFAULT 'programada',
        recordatorio_24h_enviado BOOLEAN DEFAULT FALSE,
        recordatorio_2h_enviado BOOLEAN DEFAULT FALSE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS configuracion (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clave TEXT UNIQUE,
        valor TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Nueva tabla para precios de servicios
    db.run(`CREATE TABLE IF NOT EXISTS precios_servicios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        servicio TEXT UNIQUE,
        precio DECIMAL(10,2) NOT NULL,
        activo BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

// Insertar o actualizar precios para los servicios
const serviciosDefault = [
    ['Manicure Tradicional', 4.00],
    ['Esmaltado Semipermanente', 8.00],
    ['Pedicure Tradicional', 4.00],
    ['Pedicure Semipermanente', 8.00],
    ['Acripie', 10.00],
    ['Uñas Acrílicas', 15.00],
    ['Uñas Esculturales', 20.00],
    ['Baños de Acrílico', 10.00],
    ['Retoque de Uñas', .00],
    ['Uñas Soft Gel', 10.00],
    ['Retiro de Sistemas', 3.00],
    ['Limpieza de Uñas', 2.00],
    ['Builder Gel', 10.00]
];

serviciosDefault.forEach(([servicio, precio]) => {
    // Cambiado de INSERT OR IGNORE a INSERT OR REPLACE para actualizar precios
    db.run(`INSERT OR REPLACE INTO precios_servicios (servicio, precio, activo) 
            VALUES (?, ?, 1)`, [servicio, precio]);
});

    db.run(`INSERT OR IGNORE INTO configuracion (clave, valor) 
            VALUES ('admin_phone', '593978863845')`);

    // Agregar columnas si no existen (para compatibilidad)
    db.run(`ALTER TABLE citas ADD COLUMN precio_servicio DECIMAL(10,2) DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Error agregando columna precio_servicio:', err.message);
        }
    });

    db.run(`ALTER TABLE citas ADD COLUMN completed_at DATETIME`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Error agregando columna completed_at:', err.message);
        }
    });

    db.run(`ALTER TABLE citas ADD COLUMN servicios_adicionales TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Error agregando columna servicios_adicionales:', err.message);
        }
    });
});

// RUTAS DE LA API

app.get('/api/whatsapp/status', (req, res) => {
    res.json({ 
        connected: isWhatsAppReady,
        message: isWhatsAppReady ? 'WhatsApp conectado' : 'WhatsApp desconectado'
    });
});

// Ruta para obtener servicios y precios
app.get('/api/servicios', (req, res) => {
    db.all('SELECT * FROM precios_servicios WHERE activo = 1 ORDER BY servicio', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.get('/api/citas', (req, res) => {
    db.all('SELECT * FROM citas ORDER BY fecha_cita DESC', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.post('/api/citas', (req, res) => {
    const { cliente_nombre, cliente_telefono, fecha_cita, servicio, servicios_adicionales, precio_servicio, notas } = req.body;
    
    if (!cliente_nombre || !cliente_telefono || !fecha_cita || !servicio) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    
    const telefonoLimpio = cliente_telefono.replace(/[^\d]/g, '');
    
    // Convertir array de servicios adicionales a JSON string
    const serviciosAdicionalesJSON = servicios_adicionales && servicios_adicionales.length > 0 
        ? JSON.stringify(servicios_adicionales) 
        : null;
    
    const stmt = db.prepare(`INSERT INTO citas 
        (cliente_nombre, cliente_telefono, fecha_cita, servicio, servicios_adicionales, precio_servicio, notas) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    
    stmt.run([cliente_nombre, telefonoLimpio, fecha_cita, servicio, serviciosAdicionalesJSON, precio_servicio || 0, notas], async function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        // ENVIAR MENSAJE DE CONFIRMACIÓN AL CREAR LA CITA
        if (isWhatsAppReady) {
            const fechaFormateada = moment(fecha_cita).format('DD/MM/YYYY HH:mm');
            
            // Construir lista de servicios
            let listaServicios = `💅🏻 *Servicio:* ${servicio}`;
            if (servicios_adicionales && servicios_adicionales.length > 0) {
                listaServicios += '\n➕ *Servicios adicionales:*';
                servicios_adicionales.forEach(s => {
                    listaServicios += `\n   • ${s.servicio}`;
                });
            }
            
            const mensajeConfirmacion = `💅✨ *CITA AGENDADA EXITOSAMENTE* ✨💅

¡Hola ${cliente_nombre}! 👋😊

✅ Tu cita ha sido confirmada con éxito

📅 *Fecha y Hora:* ${fechaFormateada}
${listaServicios}
💰 *Precio Total:* $${parseFloat(precio_servicio || 0).toFixed(2)}
${notas ? `📝 *Notas:* ${notas}` : ''}

*Recuerda*: Que son 15m de tolerancia, luego de eso la cita se cancela automáticamente   
⚠️ *Importante:* Si no puedes asistir, avísanos con tiempo para reprogramar tu cita 🙏

¡Te esperamos para consentir tus uñas! 💖✨

_E.j_Nailss_ 🌸`;

            // Enviar mensaje de confirmación
            enviarMensajeWhatsApp(telefonoLimpio, mensajeConfirmacion).then(enviado => {
                if (enviado) {
                    console.log(`✅ Confirmación enviada a ${cliente_nombre}`);
                } else {
                    console.log(`❌ Error enviando confirmación a ${cliente_nombre}`);
                }
            });
        }
        
        res.json({ 
            id: this.lastID, 
            message: 'Cita creada exitosamente'
        });
    });
    stmt.finalize();
});

app.put('/api/citas/:id', (req, res) => {
    const { estado, precio_servicio } = req.body;
    const citaId = req.params.id;
    
    let query = 'UPDATE citas SET';
    let params = [];
    let updates = [];
    
    // Actualizar estado si se proporciona
    if (estado !== undefined) {
        updates.push('estado = ?');
        params.push(estado);
        
        // Si se completa la cita, agregar fecha de completado
        if (estado === 'completada') {
            updates.push('completed_at = CURRENT_TIMESTAMP');
        }
    }
    
    // Actualizar precio si se proporciona (independiente del estado)
    if (precio_servicio !== undefined) {
        updates.push('precio_servicio = ?');
        params.push(precio_servicio);
    }
    
    // Si no hay nada que actualizar, retornar error
    if (updates.length === 0) {
        return res.status(400).json({ error: 'No hay datos para actualizar' });
    }
    
    query += ' ' + updates.join(', ') + ' WHERE id = ?';
    params.push(citaId);
    
    db.run(query, params, function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ message: 'Cita actualizada exitosamente' });
    });
});

app.delete('/api/citas/:id', (req, res) => {
    const citaId = req.params.id;
    
    db.run('DELETE FROM citas WHERE id = ?', [citaId], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ message: 'Cita eliminada exitosamente' });
    });
});

// Nueva ruta para estadísticas
app.get('/api/estadisticas', (req, res) => {
    const { periodo } = req.query;
    
    let fechaInicio, fechaFin;
    const hoy = new Date();
    
    switch(periodo) {
        case 'semana':
            fechaInicio = new Date(hoy);
            fechaInicio.setDate(hoy.getDate() - hoy.getDay());
            fechaFin = new Date(fechaInicio);
            fechaFin.setDate(fechaInicio.getDate() + 6);
            break;
        case 'mes':
            fechaInicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
            fechaFin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
            break;
        case 'año':
            fechaInicio = new Date(hoy.getFullYear(), 0, 1);
            fechaFin = new Date(hoy.getFullYear(), 11, 31);
            break;
        default:
            fechaInicio = new Date(hoy);
            fechaInicio.setDate(hoy.getDate() - 7);
            fechaFin = hoy;
    }
    
    const queries = {
        totalCitas: `SELECT COUNT(*) as total FROM citas WHERE 
                    fecha_cita BETWEEN ? AND ?`,
        citasCompletadas: `SELECT COUNT(*) as total FROM citas WHERE 
                          estado = 'completada' AND 
                          completed_at BETWEEN ? AND ?`,
        citasCanceladas: `SELECT COUNT(*) as total FROM citas WHERE 
                         estado = 'cancelada' AND 
                         fecha_cita BETWEEN ? AND ?`,
        ingresoTotal: `SELECT SUM(precio_servicio) as total FROM citas WHERE 
                      estado = 'completada' AND 
                      completed_at BETWEEN ? AND ?`,
        serviciosMasPopulares: `SELECT servicio, COUNT(*) as cantidad FROM citas WHERE 
                               fecha_cita BETWEEN ? AND ? 
                               GROUP BY servicio 
                               ORDER BY cantidad DESC 
                               LIMIT 5`
    };
    
    const params = [fechaInicio.toISOString(), fechaFin.toISOString()];
    
    const resultados = {};
    
    db.get(queries.totalCitas, params, (err, row) => {
        resultados.totalCitas = row ? row.total : 0;
        
        db.get(queries.citasCompletadas, params, (err, row) => {
            resultados.citasCompletadas = row ? row.total : 0;
            
            db.get(queries.citasCanceladas, params, (err, row) => {
                resultados.citasCanceladas = row ? row.total : 0;
                
                db.get(queries.ingresoTotal, params, (err, row) => {
                    resultados.ingresoTotal = row && row.total ? row.total : 0;
                    
                    db.all(queries.serviciosMasPopulares, params, (err, rows) => {
                        resultados.serviciosMasPopulares = rows || [];
                        res.json(resultados);
                    });
                });
            });
        });
    });
});

// Servir archivos estáticos
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/estadisticas', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'estadisticas.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📱 Panel administrativo: http://localhost:${PORT}`);
    console.log(`📊 Estadísticas: http://localhost:${PORT}/estadisticas`);
    console.log(`${'='.repeat(50)}\n`);
    
    // Inicializar WhatsApp después de que el servidor esté corriendo
    inicializarWhatsApp();
});

function limpiarCacheWhatsApp() {
    const authPath = path.join(__dirname, '.wwebjs_auth');
    const cachePath = path.join(__dirname, '.wwebjs_cache');
    
    try {
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log('Cache de autenticación limpiado');
        }
        if (fs.existsSync(cachePath)) {
            fs.rmSync(cachePath, { recursive: true, force: true });
            console.log('Cache de WhatsApp limpiado');
        }
    } catch (error) {
        console.error('Error limpiando cache:', error.message);
    }
}

async function inicializarWhatsApp() {
    try {
        const { Client, LocalAuth } = require('whatsapp-web.js');
        
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: "citas-client",
                dataPath: './.wwebjs_auth'
            }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            }
        });

        client.on('qr', (qr) => {
            console.log('\n=================================');
            console.log('📱 ESCANEA ESTE CÓDIGO QR CON WHATSAPP:');
            console.log('=================================\n');
            qrcode.generate(qr, { small: true });
            console.log('\n=================================');
            console.log('Abre WhatsApp en tu teléfono');
            console.log('Ve a: Dispositivos Vinculados');
            console.log('Escanea el código QR de arriba');
            console.log('=================================\n');
        });

        client.on('ready', () => {
            console.log('WhatsApp conectado exitosamente!');
            console.log('Panel disponible en: http://localhost:' + PORT);
            console.log('Estadísticas en: http://localhost:' + PORT + '/estadisticas');
            isWhatsAppReady = true;
            whatsappClient = client;
        });

        client.on('authenticated', () => {
            console.log('WhatsApp autenticado correctamente');
        });

        client.on('auth_failure', (msg) => {
            console.error('Error de autenticación WhatsApp:', msg);
            console.log('Limpiando cache y reintentando...');
            limpiarCacheWhatsApp();
        });

        client.on('disconnected', (reason) => {
            console.log('WhatsApp desconectado:', reason);
            isWhatsAppReady = false;
        });

        await client.initialize();
        
    } catch (error) {
        console.error('Error inicializando WhatsApp:', error.message);
        console.log('\nEl panel web funcionará sin WhatsApp');
        console.log('Para usar WhatsApp, ejecuta: npm install whatsapp-web.js');
    }
}

async function enviarMensajeWhatsApp(numero, mensaje) {
    if (!isWhatsAppReady || !whatsappClient) {
        console.log('WhatsApp no está conectado');
        return false;
    }
    
    try {
        let numeroFormateado = numero;
        
        if (!numeroFormateado.includes('@')) {
            numeroFormateado = numeroFormateado.replace(/[^\d]/g, '');
            
            if (!numeroFormateado.startsWith('593')) {
                if (numeroFormateado.startsWith('0')) {
                    numeroFormateado = '593' + numeroFormateado.substring(1);
                } else {
                    numeroFormateado = '593' + numeroFormateado;
                }
            }
            
            numeroFormateado = numeroFormateado + '@c.us';
        }
        
        console.log(`Enviando mensaje a: ${numeroFormateado}`);
        
        await whatsappClient.sendMessage(numeroFormateado, mensaje);
        console.log(`Mensaje enviado exitosamente a ${numero}`);
        return true;
    } catch (error) {
        console.error(`Error enviando mensaje a ${numero}:`, error.message);
        return false;
    }
}


// ========================================
// RECORDATORIO DE 24 HORAS - DESACTIVADO
// ========================================
/*
cron.schedule('/8 * * * *', async () => {
    if (!isWhatsAppReady) {
        return;
    }
    
    console.log('Verificando recordatorios pendientes...');
    
    const ahora = new Date();
    const en24horas = new Date(ahora.getTime() + 24 * 60 * 60 * 1000);
    
    db.all(`SELECT * FROM citas 
            WHERE datetime(fecha_cita) BETWEEN datetime(?) AND datetime(?) 
            AND recordatorio_24h_enviado = 0
            AND estado = 'programada'`, 
        [ahora.toISOString(), en24horas.toISOString()], 
        async (err, citas) => {
            if (err || !citas.length) return;
            
            console.log(`Encontradas ${citas.length} citas para recordatorio 24h`);
            
            for (const cita of citas) {
                const fechaFormateada = moment(cita.fecha_cita).format('DD/MM/YYYY HH:mm');
                
                let listaServicios = `💅🏻 *Servicio:* ${cita.servicio}`;
                if (cita.servicios_adicionales) {
                    try {
                        const serviciosAdicionales = JSON.parse(cita.servicios_adicionales);
                        if (serviciosAdicionales.length > 0) {
                            listaServicios += '\n➕ *Servicios adicionales:*';
                            serviciosAdicionales.forEach(s => {
                                listaServicios += `\n   • ${s.servicio}`;
                            });
                        }
                    } catch (e) {
                        console.error('Error parseando servicios adicionales:', e);
                    }
                }
                
                const mensaje = `💅✨ *RECORDATORIO DE CITA* ✨💅

¡Hola ${cita.cliente_nombre}! 👋😊

🗓️ Te recordamos que *mañana* tienes tu cita:

📅 *Fecha:* ${fechaFormateada}
${listaServicios}
${cita.notas ? `📝 *Notas:* ${cita.notas}` : ''}

*Recuerda*: Que son 15m de tolerancia, luego de eso la cita se cancela automaticamente   
⚠️ *Importante:* Si no puedes asistir, avísanos con tiempo para reprogramar tu cita 🙏

¡Te esperamos para consentir tus uñas! 💖✨

_E.j_Nailss_ 🌸`;

                const enviado = await enviarMensajeWhatsApp(cita.cliente_telefono, mensaje);
                
                if (enviado) {
                    db.run('UPDATE citas SET recordatorio_24h_enviado = 1 WHERE id = ?', [cita.id]);
                    console.log(`Recordatorio 24h enviado a ${cita.cliente_nombre}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        });
});
*/


// ========================================
// RECORDATORIO DE 2 HORAS - ACTIVO
// ========================================
cron.schedule('*/5 * * * *', async () => {
    if (!isWhatsAppReady) {
        return;
    }
    
    console.log('Verificando recordatorios 2h pendientes...');
    
    // Usar moment con zona horaria de Ecuador para cálculos
    const ahora = moment().tz('America/Guayaquil');
    const en2horas = moment(ahora).add(2, 'hours');
    const ventana_inicio = moment(en2horas).subtract(15, 'minutes');
    const ventana_fin = moment(en2horas).add(15, 'minutes');
    
    console.log(`Hora actual Ecuador: ${ahora.format('YYYY-MM-DD HH:mm:ss')}`);
    console.log(`Buscando citas entre: ${ventana_inicio.format('YYYY-MM-DD HH:mm:ss')} y ${ventana_fin.format('YYYY-MM-DD HH:mm:ss')}`);
    
    db.all(`SELECT *, datetime(fecha_cita) as fecha_cita_formatted FROM citas 
            WHERE datetime(fecha_cita) BETWEEN datetime(?) AND datetime(?) 
            AND recordatorio_2h_enviado = 0
            AND estado = 'programada'`, 
        [ventana_inicio.format('YYYY-MM-DD HH:mm:ss'), ventana_fin.format('YYYY-MM-DD HH:mm:ss')], 
        async (err, citas) => {
            if (err) {
                console.error('Error en consulta 2h:', err);
                return;
            }
            
            if (!citas.length) {
                console.log('No se encontraron citas para recordatorio 2h');
                // Debug: mostrar todas las citas programadas próximas
                db.all(`SELECT *, datetime(fecha_cita) as fecha_cita_formatted FROM citas 
                        WHERE datetime(fecha_cita) > datetime('now', 'localtime') 
                        AND estado = 'programada' 
                        ORDER BY fecha_cita LIMIT 5`, (err, todasCitas) => {
                    if (!err && todasCitas.length > 0) {
                        console.log('=== CITAS PRÓXIMAS (DEBUG) ===');
                        todasCitas.forEach(cita => {
                            const citaMoment = moment(cita.fecha_cita);
                            const diferencia = citaMoment.diff(ahora, 'minutes');
                            console.log(`${cita.cliente_nombre}: ${cita.fecha_cita_formatted} (en ${diferencia} minutos) - 2h enviado: ${cita.recordatorio_2h_enviado}`);
                        });
                        console.log('================================');
                    }
                });
                return;
            }
            
            console.log(`Encontradas ${citas.length} citas para recordatorio 2h`);
            
            for (const cita of citas) {
                const fechaFormateada = moment(cita.fecha_cita).format('DD/MM/YYYY HH:mm');
                
                // Construir lista de servicios
                let listaServicios = `💅 *Servicio:* ${cita.servicio}`;
                if (cita.servicios_adicionales) {
                    try {
                        const serviciosAdicionales = JSON.parse(cita.servicios_adicionales);
                        if (serviciosAdicionales.length > 0) {
                            listaServicios += '\n➕ *Servicios adicionales:*';
                            serviciosAdicionales.forEach(s => {
                                listaServicios += `\n   • ${s.servicio}`;
                            });
                        }
                    } catch (e) {
                        console.error('Error parseando servicios adicionales:', e);
                    }
                }
                
                const mensaje = `⏰ *¡TU CITA ES HOY!* ⏰

Hola ${cita.cliente_nombre}! 💕

🚨 *Recordatorio urgente:* Tu cita es en aproximadamente 2 horas

⏰ *Hora:* ${fechaFormateada}
${listaServicios}
${cita.notas ? `📝 *Notas:* ${cita.notas}` : ''}

📍 No olvides llegar puntual
⚠️ *Importante:* Si no puedes asistir, avísanos con tiempo para reprogramar tu cita 🙏

¡Nos vemos muy pronto! 😊✨

_E.j_Nailss_ 🌸`;

                const enviado = await enviarMensajeWhatsApp(cita.cliente_telefono, mensaje);
                
                if (enviado) {
                    db.run('UPDATE citas SET recordatorio_2h_enviado = 1 WHERE id = ?', [cita.id]);
                    console.log(`✅ Recordatorio 2h enviado a ${cita.cliente_nombre}`);
                } else {
                    console.log(`❌ Error enviando recordatorio a ${cita.cliente_nombre}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        });
});

// Cerrar correctamente
process.on('SIGINT', () => {
    console.log('\nCerrando servidor...');
    
    if (whatsappClient) {
        whatsappClient.destroy();
    }
    
    db.close((err) => {
        if (err) {
            console.error('Error cerrando base de datos:', err.message);
        }
        console.log('Base de datos cerrada.');
        process.exit(0);
    });
});
