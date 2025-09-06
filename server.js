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

    // Insertar precios por defecto para los servicios
    const serviciosDefault = [
        ['Manicure Tradicional', 15.00],
        ['Esmaltado Semipermanente', 25.00],
        ['Pedicure Tradicional', 20.00],
        ['Pedicure Semipermanente', 30.00],
        ['Acripie', 35.00],
        ['Uñas Acrílicas', 40.00],
        ['Uñas Esculturales', 45.00],
        ['Baños de Acrílico', 35.00],
        ['Retoque de Uñas', 20.00],
        ['Uñas Soft Gel', 35.00],
        ['Retiro de Sistemas', 15.00],
        ['Limpieza de Uñas', 12.00]
    ];

    serviciosDefault.forEach(([servicio, precio]) => {
        db.run(`INSERT OR IGNORE INTO precios_servicios (servicio, precio) VALUES (?, ?)`, [servicio, precio]);
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
    const { cliente_nombre, cliente_telefono, fecha_cita, servicio, precio_servicio, notas } = req.body;
    
    if (!cliente_nombre || !cliente_telefono || !fecha_cita || !servicio) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    
    const telefonoLimpio = cliente_telefono.replace(/[^\d]/g, '');
    
    const stmt = db.prepare(`INSERT INTO citas 
        (cliente_nombre, cliente_telefono, fecha_cita, servicio, precio_servicio, notas) 
        VALUES (?, ?, ?, ?, ?, ?)`);
    
    stmt.run([cliente_nombre, telefonoLimpio, fecha_cita, servicio, precio_servicio || 0, notas], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
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
    
    // Si se está completando la cita, agregar fecha de completado
    let query = 'UPDATE citas SET estado = ?';
    let params = [estado];
    
    if (estado === 'completada') {
        query += ', completed_at = CURRENT_TIMESTAMP';
        if (precio_servicio !== undefined) {
            query += ', precio_servicio = ?';
            params.push(precio_servicio);
        }
    }
    
    query += ' WHERE id = ?';
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
    
    const fechaInicioStr = fechaInicio.toISOString().split('T')[0];
    const fechaFinStr = fechaFin.toISOString().split('T')[0];
    
    // Consultar estadísticas
    db.all(`
        SELECT 
            COUNT(*) as total_citas,
            SUM(CASE WHEN estado = 'completada' THEN 1 ELSE 0 END) as citas_completadas,
            SUM(CASE WHEN estado = 'cancelada' THEN 1 ELSE 0 END) as citas_canceladas,
            SUM(CASE WHEN estado = 'completada' THEN precio_servicio ELSE 0 END) as ingresos_total,
            AVG(CASE WHEN estado = 'completada' THEN precio_servicio ELSE NULL END) as promedio_servicio
        FROM citas 
        WHERE date(completed_at) BETWEEN ? AND ? OR date(fecha_cita) BETWEEN ? AND ?
    `, [fechaInicioStr, fechaFinStr, fechaInicioStr, fechaFinStr], (err, estadisticas) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        // Consultar servicios más populares
        db.all(`
            SELECT servicio, COUNT(*) as cantidad, SUM(precio_servicio) as ingresos
            FROM citas 
            WHERE estado = 'completada' AND date(completed_at) BETWEEN ? AND ?
            GROUP BY servicio 
            ORDER BY cantidad DESC
            LIMIT 5
        `, [fechaInicioStr, fechaFinStr], (err, serviciosPopulares) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            // Consultar ingresos por día
            db.all(`
                SELECT date(completed_at) as fecha, SUM(precio_servicio) as ingresos_dia, COUNT(*) as citas_dia
                FROM citas 
                WHERE estado = 'completada' AND date(completed_at) BETWEEN ? AND ?
                GROUP BY date(completed_at)
                ORDER BY fecha
            `, [fechaInicioStr, fechaFinStr], (err, ingresosDiarios) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                
                res.json({
                    periodo: periodo || 'personalizado',
                    fecha_inicio: fechaInicioStr,
                    fecha_fin: fechaFinStr,
                    resumen: estadisticas[0],
                    servicios_populares: serviciosPopulares,
                    ingresos_diarios: ingresosDiarios
                });
            });
        });
    });
});

// Nueva ruta para enviar promociones masivas
app.post('/api/promocion-masiva', async (req, res) => {
    const { mensaje } = req.body;
    
    if (!isWhatsAppReady) {
        return res.status(400).json({ 
            success: false, 
            message: 'WhatsApp no está conectado' 
        });
    }
    
    if (!mensaje || mensaje.trim().length === 0) {
        return res.status(400).json({
            success: false,
            message: 'El mensaje no puede estar vacío'
        });
    }
    
    try {
        // Obtener todos los números únicos de clientes
        db.all(`SELECT DISTINCT cliente_telefono, cliente_nombre 
                FROM citas 
                WHERE cliente_telefono IS NOT NULL 
                ORDER BY cliente_nombre`, 
            async (err, clientes) => {
                if (err) {
                    return res.status(500).json({ 
                        success: false, 
                        error: err.message 
                    });
                }
                
                console.log(`Enviando promoción a ${clientes.length} clientes...`);
                
                let enviados = 0;
                let errores = 0;
                
                for (const cliente of clientes) {
                    try {
                        const mensajePersonalizado = `Hola ${cliente.cliente_nombre}! 👋\n\n${mensaje}\n\n_Nail Studio_ 🌸`;
                        const enviado = await enviarMensajeWhatsApp(cliente.cliente_telefono, mensajePersonalizado);
                        
                        if (enviado) {
                            enviados++;
                            console.log(`✅ Promoción enviada a ${cliente.cliente_nombre}`);
                        } else {
                            errores++;
                            console.log(`❌ Error enviando a ${cliente.cliente_nombre}`);
                        }
                        
                        // Esperar 3 segundos entre cada envío para no saturar WhatsApp
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        
                    } catch (error) {
                        errores++;
                        console.error(`Error enviando a ${cliente.cliente_nombre}:`, error);
                    }
                }
                
                res.json({
                    success: true,
                    enviados: enviados,
                    errores: errores,
                    total: clientes.length,
                    message: `Promoción enviada a ${enviados} de ${clientes.length} clientes`
                });
            });
    } catch (error) {
        console.error('Error enviando promoción masiva:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

app.post('/api/test-message', async (req, res) => {
    const { numero, mensaje } = req.body;
    
    if (!isWhatsAppReady) {
        return res.status(400).json({ 
            success: false, 
            message: 'WhatsApp no está conectado' 
        });
    }
    
    const enviado = await enviarMensajeWhatsApp(numero, mensaje);
    res.json({ 
        success: enviado, 
        message: enviado ? 'Mensaje enviado exitosamente' : 'Error enviando mensaje' 
    });
});

app.get('/api/configuracion', (req, res) => {
    db.all('SELECT * FROM configuracion', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        const config = {};
        rows.forEach(row => {
            config[row.clave] = row.valor;
        });
        res.json(config);
    });
});

app.post('/api/configuracion', (req, res) => {
    const { clave, valor } = req.body;
    
    db.run(`INSERT OR REPLACE INTO configuracion (clave, valor, updated_at) 
            VALUES (?, ?, CURRENT_TIMESTAMP)`, [clave, valor], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ message: 'Configuración guardada exitosamente' });
    });
});

// Rutas de páginas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/config', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

app.get('/estadisticas', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'estadisticas.html'));
});

// Iniciar servidor ANTES de WhatsApp
app.listen(PORT, () => {
    console.log('\n========================================');
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
    console.log('Panel administrativo disponible');
    console.log('Estadísticas disponibles en /estadisticas');
    console.log('========================================\n');
    
    // Inicializar WhatsApp después del servidor
    inicializarWhatsApp();
});

// FUNCIONES DE WHATSAPP

function limpiarCacheWhatsApp() {
    try {
        if (fs.existsSync('./whatsapp-session')) {
            fs.rmSync('./whatsapp-session', { recursive: true, force: true });
        }
        if (fs.existsSync('./.wwebjs_auth')) {
            fs.rmSync('./.wwebjs_auth', { recursive: true, force: true });
        }
    } catch (error) {
        console.log('Cache ya limpio o no existe');
    }
}

async function inicializarWhatsApp() {
    try {
        console.log('Cargando WhatsApp Web...');
        
        const { Client, LocalAuth } = require('whatsapp-web.js');
        
        const client = new Client({
            authStrategy: new LocalAuth({
                dataPath: './whatsapp-session'
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
            console.log('ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP:');
            console.log('=================================');
            qrcode.generate(qr, { small: true });
            console.log('\nPASOS PARA CONECTAR:');
            console.log('1. Abre WhatsApp en tu teléfono');
            console.log('2. Ve a Configuración > Dispositivos vinculados');
            console.log('3. Toca "Vincular un dispositivo"');
            console.log('4. Escanea el código QR de arriba');
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



cron.schedule('*/8 * * * *', async () => {
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
                const mensaje = `💅✨ *RECORDATORIO DE CITA* ✨💅

¡Hola ${cita.cliente_nombre}! 👋😊

🗓️ Te recordamos que *mañana* tienes tu cita:

📅 *Fecha:* ${fechaFormateada}
💅🏻 *Servicio:* ${cita.servicio}
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


// RECORDATORIO DE 2 HORAS CORREGIDO CON ZONA HORARIA
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
                
                // TU MENSAJE ORIGINAL - NO LO CAMBIO
                const mensaje = `⏰ *¡TU CITA ES HOY!* ⏰

Hola ${cita.cliente_nombre}! 💕

🚨 *Recordatorio urgente:* Tu cita es en aproximadamente 2 horas

⏰ *Hora:* ${fechaFormateada}
💅 *Servicio:* ${cita.servicio}
${cita.notas ? `📝 *Notas:* ${cita.notas}` : ''}

📍 No olvides llegar puntual
⚠️ *Importante:* Si no puedes asistir, avísanos con tiempo para reprogramar tu cita 🙏

¡Nos vemos muy pronto! 😊✨

_Nail Studio_ 🌸`;

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