const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mime = require('mime-types');
require('dotenv').config();

// ==================== CONFIGURACIÓN INICIAL ====================
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    console.error('❌ Error: No se encontró el token en el archivo .env');
    process.exit(1);
}

const botOptions = {
    polling: {
        interval: 300,
        timeout: 10,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
};

const bot = new TelegramBot(token, botOptions);

// Variables de control
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000;

// Rutas de directorios
const DB_PATH = path.join(__dirname, 'database.json');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const DOCUMENTS_DIR = path.join(DOWNLOADS_DIR, 'documents');
const PHOTOS_DIR = path.join(DOWNLOADS_DIR, 'photos');
const VIDEOS_DIR = path.join(DOWNLOADS_DIR, 'videos');
const AUDIO_DIR = path.join(DOWNLOADS_DIR, 'audio');
const OTHER_DIR = path.join(DOWNLOADS_DIR, 'other');

// ==================== FUNCIONES AUXILIARES ====================

function createDirectories() {
    const directories = [DOWNLOADS_DIR, DOCUMENTS_DIR, PHOTOS_DIR, VIDEOS_DIR, AUDIO_DIR, OTHER_DIR];
    
    directories.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`📁 Directorio creado: ${dir}`);
        }
    });
}

function loadDatabase() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const initialDB = {
                users: [],
                files: []
            };
            fs.writeFileSync(DB_PATH, JSON.stringify(initialDB, null, 2));
            console.log('📊 Base de datos inicial creada');
            return initialDB;
        }
        
        const data = fs.readFileSync(DB_PATH, 'utf8');
        const db = JSON.parse(data);
        
        if (!db.users) db.users = [];
        if (!db.files) db.files = [];
        
        return db;
    } catch (error) {
        console.error('❌ Error crítico cargando la base de datos:', error);
        return { users: [], files: [] };
    }
}

function saveDatabase(db) {
    try {
        if (!db.users) db.users = [];
        if (!db.files) db.files = [];
        
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Error guardando en la base de datos:', error);
        return false;
    }
}

function isUserRegistered(userId) {
    try {
        const db = loadDatabase();
        return db.users && Array.isArray(db.users) ? db.users.some(user => user.id === userId) : false;
    } catch (error) {
        console.error('❌ Error en isUserRegistered:', error);
        return false;
    }
}

function registerUser(user) {
    try {
        const db = loadDatabase();
        
        if (!db.users) db.users = [];
        
        if (db.users.some(u => u.id === user.id)) {
            return false;
        }
        
        db.users.push({
            id: user.id,
            username: user.username || 'Sin username',
            first_name: user.first_name || 'Sin nombre',
            last_name: user.last_name || 'Sin apellido',
            registered_at: new Date().toISOString()
        });
        
        return saveDatabase(db);
    } catch (error) {
        console.error('❌ Error en registerUser:', error);
        return false;
    }
}

function getUserFiles(userId) {
    try {
        const db = loadDatabase();
        
        if (!db.files || !Array.isArray(db.files)) {
            console.warn('⚠️ db.files no es un array, retornando array vacío');
            return [];
        }
        
        return db.files.filter(file => file.user_id === userId);
    } catch (error) {
        console.error('❌ Error en getUserFiles:', error);
        return [];
    }
}

function saveFileInfo(fileInfo) {
    try {
        const db = loadDatabase();
        
        if (!db.files) db.files = [];
        
        if (db.files.some(file => file.file_id === fileInfo.file_id)) {
            return false;
        }
        
        db.files.push(fileInfo);
        return saveDatabase(db);
    } catch (error) {
        console.error('❌ Error en saveFileInfo:', error);
        return false;
    }
}

function getFileExtension(filename) {
    return path.extname(filename).toLowerCase() || '.unknown';
}

function getFileTypeAndDir(mimeType, filename) {
    const ext = getFileExtension(filename);
    
    if (mimeType.startsWith('image/')) {
        return { type: 'photo', dir: PHOTOS_DIR };
    } else if (mimeType.startsWith('video/')) {
        return { type: 'video', dir: VIDEOS_DIR };
    } else if (mimeType.startsWith('audio/')) {
        return { type: 'audio', dir: AUDIO_DIR };
    } else if (mimeType.includes('pdf') || 
               mimeType.includes('document') || 
               ['.doc', '.docx', '.txt', '.pdf', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) {
        return { type: 'document', dir: DOCUMENTS_DIR };
    } else {
        return { type: 'other', dir: OTHER_DIR };
    }
}

async function downloadAndSaveFile(fileId, fileName, userId) {
    try {
        console.log(`📥 Iniciando descarga de archivo: ${fileName} para usuario: ${userId}`);
        
        const fileLink = await bot.getFileLink(fileId);
        console.log(`🔗 Enlace de descarga obtenido: ${fileLink}`);
        
        const response = await axios({
            method: 'GET',
            url: fileLink,
            responseType: 'stream',
            timeout: 30000
        });

        const mimeType = response.headers['content-type'] || 'application/octet-stream';
        const { type, dir } = getFileTypeAndDir(mimeType, fileName);
        
        console.log(`📊 Tipo de archivo detectado: ${type}, MIME: ${mimeType}`);
        console.log(`📂 Directorio de destino: ${dir}`);
        
        const timestamp = Date.now();
        const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        const uniqueFileName = `${userId}_${timestamp}_${safeFileName}`;
        const filePath = path.join(dir, uniqueFileName);

        console.log(`💾 Guardando como: ${uniqueFileName}`);
        console.log(`📍 Ruta completa: ${filePath}`);

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                try {
                    const stats = fs.statSync(filePath);
                    const fileSizeKB = (stats.size / 1024).toFixed(2);
                    
                    console.log(`✅ Archivo guardado en disco - Tamaño: ${fileSizeKB} KB`);
                    
                    const fileInfo = {
                        file_id: fileId,
                        file_name: fileName,
                        saved_name: uniqueFileName,
                        file_path: filePath,
                        file_type: type,
                        mime_type: mimeType,
                        user_id: userId,
                        uploaded_at: new Date().toISOString(),
                        file_size: stats.size
                    };
                    
                    if (saveFileInfo(fileInfo)) {
                        console.log(`📝 Información del archivo guardada en BD: ${fileName}`);
                        console.log(`👤 Usuario: ${userId}`);
                        console.log(`🆔 File ID: ${fileId}`);
                        console.log(`📦 Tipo: ${type}`);
                        console.log(`💾 Tamaño: ${fileSizeKB} KB`);
                        console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
                        console.log('📋', '-'.repeat(50));
                        
                        resolve(fileInfo);
                    } else {
                        console.error('❌ Error guardando información en BD');
                        reject(new Error('Error guardando información del archivo en BD'));
                    }
                } catch (error) {
                    console.error('❌ Error en evento finish:', error);
                    reject(error);
                }
            });
            
            writer.on('error', (error) => {
                console.error('❌ Error escribiendo archivo:', error);
                reject(error);
            });
        });
        
    } catch (error) {
        console.error('❌ Error en downloadAndSaveFile:', error);
        throw error;
    }
}

function repairDatabase() {
    try {
        console.log('🛠️ Intentando reparar base de datos...');
        
        if (fs.existsSync(DB_PATH)) {
            const backupPath = DB_PATH + '.backup.' + Date.now();
            fs.copyFileSync(DB_PATH, backupPath);
            console.log('📦 Backup creado:', backupPath);
        }
        
        const newDB = { users: [], files: [] };
        fs.writeFileSync(DB_PATH, JSON.stringify(newDB, null, 2));
        console.log('✅ Base de datos reparada');
        return newDB;
    } catch (error) {
        console.error('❌ Error reparando base de datos:', error);
        return { users: [], files: [] };
    }
}

async function reconnectBot() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Máximo número de intentos de reconexión alcanzado');
        return false;
    }
    
    reconnectAttempts++;
    console.log(`🔄 Intentando reconexión ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
    
    try {
        bot.stopPolling();
        await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
        bot.startPolling();
        isConnected = true;
        reconnectAttempts = 0;
        console.log('✅ Reconexión exitosa');
        return true;
    } catch (error) {
        console.error('❌ Error en reconexión:', error.message);
        return false;
    }
}

function showStartupStats() {
    const db = loadDatabase();
    console.log('📊 ESTADÍSTICAS INICIALES:');
    console.log(`   👥 Usuarios registrados: ${db.users.length}`);
    console.log(`   📁 Archivos totales: ${db.files.length}`);
    
    if (db.files.length > 0) {
        const stats = db.files.reduce((acc, file) => {
            acc[file.file_type] = (acc[file.file_type] || 0) + 1;
            return acc;
        }, {});
        
        console.log(`   📈 Distribución por tipo:`);
        Object.entries(stats).forEach(([type, count]) => {
            console.log(`      ${type}: ${count} archivos`);
        });
    }
    console.log('='.repeat(50));
}

// ==================== INTERFAZ DE USUARIO ====================

function createMainMenu() {
    return {
        reply_markup: {
            keyboard: [
                ['📊 Ver mi información', '📁 Mis archivos'],
                ['📤 Subir archivo', '🆘 Ayuda'],
                ['⚙️ Configuración', '🔁 Estado del Bot']
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    };
}

function createRegisterKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ Registrarme', callback_data: 'register' }]
            ]
        }
    };
}

function sendWelcomeMessage(chatId, userName) {
    const welcomeMessage = `👋 Hola ${userName || 'usuario'}!\n\n` +
                          '⚠️ *No estás registrado en nuestro sistema.*\n\n' +
                          'Para acceder a todas las funciones del bot, incluyendo subir archivos, necesitas registrarte.';
    
    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        ...createRegisterKeyboard()
    }).catch(error => {
        console.error('❌ Error enviando mensaje de bienvenida:', error.message);
    });
}

function sendMainMenu(chatId, userName) {
    const menuMessage = `🎉 ¡Bienvenido de nuevo ${userName || 'usuario'}!\n\n` +
                       '¿Qué te gustaría hacer hoy?';
    
    bot.sendMessage(chatId, menuMessage, createMainMenu()).catch(error => {
        console.error('❌ Error enviando menú principal:', error.message);
    });
}

// ==================== MANEJADORES DE COMANDOS ====================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    
    console.log(`👤 Comando /start de: ${user.first_name} (ID: ${user.id})`);
    
    if (isUserRegistered(user.id)) {
        sendMainMenu(chatId, user.first_name);
    } else {
        sendWelcomeMessage(chatId, user.first_name);
    }
});

bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const db = loadDatabase();
        const statusMessage = `🤖 *Estado del Bot*\n\n` +
                             `✅ Conectado: ${isConnected ? 'Sí' : 'No'}\n` +
                             `🔄 Intentos de reconexión: ${reconnectAttempts}\n` +
                             `📊 Usuarios registrados: ${db.users ? db.users.length : 'N/A'}\n` +
                             `📁 Archivos guardados: ${db.files ? db.files.length : 'N/A'}\n` +
                             `⏰ Última actualización: ${new Date().toLocaleString()}`;
        
        bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' }).catch(error => {
            console.error('❌ Error enviando estado:', error.message);
        });
    } catch (error) {
        console.error('❌ Error en comando /status:', error);
        bot.sendMessage(chatId, '❌ Error obteniendo estado del bot.', { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/repair/, (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    
    const ADMIN_IDS = [123456789]; // Reemplaza con tu ID de Telegram
    
    if (!ADMIN_IDS.includes(user.id)) {
        bot.sendMessage(chatId, '❌ No tienes permisos para usar este comando.');
        return;
    }
    
    try {
        repairDatabase();
        bot.sendMessage(chatId, '✅ Base de datos reparada exitosamente.');
    } catch (error) {
        console.error('❌ Error en comando /repair:', error);
        bot.sendMessage(chatId, '❌ Error reparando la base de datos.');
    }
});

// ==================== MANEJADORES DE ARCHIVOS ====================

bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const document = msg.document;
    
    console.log(`📄 Documento recibido de ${user.first_name} (${user.id}): ${document.file_name}`);
    console.log(`📊 Tamaño del documento: ${document.file_size} bytes`);
    console.log(`🆔 File ID: ${document.file_id}`);
    
    if (!isUserRegistered(user.id)) {
        console.log(`⚠️ Usuario no registrado intentó subir archivo: ${user.id}`);
        sendWelcomeMessage(chatId, user.first_name);
        return;
    }
    
    try {
        console.log(`⏳ Procesando documento: ${document.file_name}`);
        
        const processingMsg = await bot.sendMessage(chatId, '📥 *Procesando archivo...*', {
            parse_mode: 'Markdown'
        });
        
        const fileInfo = await downloadAndSaveFile(document.file_id, document.file_name, user.id);
        
        const successMessage = `✅ *Archivo guardado exitosamente!*\n\n` +
                              `📄 *Nombre:* ${fileInfo.file_name}\n` +
                              `📦 *Tipo:* ${fileInfo.file_type}\n` +
                              `💾 *Tamaño:* ${(fileInfo.file_size / 1024).toFixed(2)} KB\n` +
                              `📅 *Guardado:* ${new Date().toLocaleString()}`;
        
        await bot.editMessageText(successMessage, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown'
        });
        
        console.log(`🎉 Documento procesado exitosamente: ${document.file_name}`);
        console.log(`📋 Resumen:`);
        console.log(`   👤 Usuario: ${user.first_name} (${user.id})`);
        console.log(`   📄 Archivo: ${fileInfo.file_name}`);
        console.log(`   📦 Tipo: ${fileInfo.file_type}`);
        console.log(`   💾 Tamaño: ${(fileInfo.file_size / 1024).toFixed(2)} KB`);
        console.log(`   📍 Ruta: ${fileInfo.file_path}`);
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('❌ Error procesando documento:', error);
        bot.sendMessage(chatId, '❌ *Error al procesar el archivo.* Intenta nuevamente.', {
            parse_mode: 'Markdown'
        });
    }
});

bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const photo = msg.photo[msg.photo.length - 1];
    
    console.log(`🖼️ Foto recibida de ${user.first_name} (${user.id})`);
    console.log(`📊 Tamaño de la foto: ${photo.file_size} bytes`);
    console.log(`🆔 File ID: ${photo.file_id}`);
    
    if (!isUserRegistered(user.id)) {
        console.log(`⚠️ Usuario no registrado intentó subir foto: ${user.id}`);
        sendWelcomeMessage(chatId, user.first_name);
        return;
    }
    
    try {
        console.log(`⏳ Procesando foto...`);
        
        const processingMsg = await bot.sendMessage(chatId, '📥 *Procesando imagen...*', {
            parse_mode: 'Markdown'
        });
        
        const fileInfo = await downloadAndSaveFile(photo.file_id, `photo_${Date.now()}.jpg`, user.id);
        
        const successMessage = `✅ *Imagen guardada exitosamente!*\n\n` +
                              `🖼️ *Tipo:* Foto\n` +
                              `💾 *Tamaño:* ${(fileInfo.file_size / 1024).toFixed(2)} KB\n` +
                              `📅 *Guardado:* ${new Date().toLocaleString()}`;
        
        await bot.editMessageText(successMessage, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown'
        });
        
        console.log(`🎉 Foto procesada exitosamente`);
        console.log(`📋 Resumen:`);
        console.log(`   👤 Usuario: ${user.first_name} (${user.id})`);
        console.log(`   🖼️ Archivo: ${fileInfo.file_name}`);
        console.log(`   📦 Tipo: ${fileInfo.file_type}`);
        console.log(`   💾 Tamaño: ${(fileInfo.file_size / 1024).toFixed(2)} KB`);
        console.log(`   📍 Ruta: ${fileInfo.file_path}`);
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('❌ Error procesando foto:', error);
        bot.sendMessage(chatId, '❌ *Error al procesar la imagen.*', {
            parse_mode: 'Markdown'
        });
    }
});

bot.on('video', async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const video = msg.video;
    
    console.log(`🎥 Video recibido de ${user.first_name} (${user.id}): ${video.file_name || 'sin nombre'}`);
    console.log(`📊 Tamaño del video: ${video.file_size} bytes`);
    console.log(`🆔 File ID: ${video.file_id}`);
    
    if (!isUserRegistered(user.id)) {
        console.log(`⚠️ Usuario no registrado intentó subir video: ${user.id}`);
        sendWelcomeMessage(chatId, user.first_name);
        return;
    }
    
    try {
        console.log(`⏳ Procesando video...`);
        
        const processingMsg = await bot.sendMessage(chatId, '📥 *Procesando video...*', {
            parse_mode: 'Markdown'
        });
        
        const fileName = video.file_name || `video_${Date.now()}.mp4`;
        const fileInfo = await downloadAndSaveFile(video.file_id, fileName, user.id);
        
        const successMessage = `✅ *Video guardado exitosamente!*\n\n` +
                              `🎥 *Tipo:* Video\n` +
                              `💾 *Tamaño:* ${(fileInfo.file_size / 1024).toFixed(2)} KB\n` +
                              `📅 *Guardado:* ${new Date().toLocaleString()}`;
        
        await bot.editMessageText(successMessage, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown'
        });
        
        console.log(`🎉 Video procesado exitosamente: ${fileName}`);
        console.log(`📋 Resumen:`);
        console.log(`   👤 Usuario: ${user.first_name} (${user.id})`);
        console.log(`   🎥 Archivo: ${fileInfo.file_name}`);
        console.log(`   📦 Tipo: ${fileInfo.file_type}`);
        console.log(`   💾 Tamaño: ${(fileInfo.file_size / 1024).toFixed(2)} KB`);
        console.log(`   📍 Ruta: ${fileInfo.file_path}`);
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('❌ Error procesando video:', error);
        bot.sendMessage(chatId, '❌ *Error al procesar el video.*', {
            parse_mode: 'Markdown'
        });
    }
});

bot.on('audio', async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const audio = msg.audio;
    
    console.log(`🎵 Audio recibido de ${user.first_name} (${user.id}): ${audio.file_name || 'sin nombre'}`);
    console.log(`📊 Tamaño del audio: ${audio.file_size} bytes`);
    console.log(`🆔 File ID: ${audio.file_id}`);
    
    if (!isUserRegistered(user.id)) {
        console.log(`⚠️ Usuario no registrado intentó subir audio: ${user.id}`);
        sendWelcomeMessage(chatId, user.first_name);
        return;
    }
    
    try {
        console.log(`⏳ Procesando audio...`);
        
        const processingMsg = await bot.sendMessage(chatId, '📥 *Procesando audio...*', {
            parse_mode: 'Markdown'
        });
        
        const fileName = audio.file_name || `audio_${Date.now()}.mp3`;
        const fileInfo = await downloadAndSaveFile(audio.file_id, fileName, user.id);
        
        const successMessage = `✅ *Audio guardado exitosamente!*\n\n` +
                              `🎵 *Tipo:* Audio\n` +
                              `💾 *Tamaño:* ${(fileInfo.file_size / 1024).toFixed(2)} KB\n` +
                              `📅 *Guardado:* ${new Date().toLocaleString()}`;
        
        await bot.editMessageText(successMessage, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown'
        });
        
        console.log(`🎉 Audio procesado exitosamente: ${fileName}`);
        console.log(`📋 Resumen:`);
        console.log(`   👤 Usuario: ${user.first_name} (${user.id})`);
        console.log(`   🎵 Archivo: ${fileInfo.file_name}`);
        console.log(`   📦 Tipo: ${fileInfo.file_type}`);
        console.log(`   💾 Tamaño: ${(fileInfo.file_size / 1024).toFixed(2)} KB`);
        console.log(`   📍 Ruta: ${fileInfo.file_path}`);
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('❌ Error procesando audio:', error);
        bot.sendMessage(chatId, '❌ *Error al procesar el audio.*', {
            parse_mode: 'Markdown'
        });
    }
});

// ==================== MANEJADOR DE REGISTRO ====================

bot.on('callback_query', (callbackQuery) => {
    const message = callbackQuery.message;
    const user = callbackQuery.from;
    const data = callbackQuery.data;
    
    if (data === 'register') {
        if (isUserRegistered(user.id)) {
            bot.answerCallbackQuery(callbackQuery.id, {
                text: '✅ Ya estás registrado!'
            });
            sendMainMenu(message.chat.id, user.first_name);
        } else {
            if (registerUser(user)) {
                bot.answerCallbackQuery(callbackQuery.id, {
                    text: '🎉 ¡Registro exitoso!'
                });
                bot.sendMessage(message.chat.id, 
                    '✅ *¡Registro completado!*\n\nAhora tienes acceso a todas las funciones del bot.',
                    { parse_mode: 'Markdown' }
                );
                sendMainMenu(message.chat.id, user.first_name);
            } else {
                bot.answerCallbackQuery(callbackQuery.id, {
                    text: '❌ Error en el registro'
                });
            }
        }
    }
});

// ==================== MANEJADOR DE MENÚ PRINCIPAL ====================

bot.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id;
    const user = msg.from;
    const text = msg.text;
    
    if (!user) {
        console.warn('⚠️ Mensaje sin información de usuario');
        return;
    }
    
    if (!isUserRegistered(user.id)) {
        sendWelcomeMessage(chatId, user.first_name);
        return;
    }
    
    try {
        switch (text) {
            case '📊 Ver mi información':
                const db = loadDatabase();
                const userInfo = db.users.find(u => u.id === user.id);
                const userFiles = getUserFiles(user.id);
                
                if (!userInfo) {
                    bot.sendMessage(chatId, '❌ No se encontró tu información en la base de datos.');
                    return;
                }
                
                const infoMessage = `👤 *Tu información:*\n\n` +
                                   `🆔 ID: ${userInfo.id}\n` +
                                   `👤 Nombre: ${userInfo.first_name}\n` +
                                   `📛 Apellido: ${userInfo.last_name || 'No especificado'}\n` +
                                   `🌐 Username: @${userInfo.username || 'No tiene'}\n` +
                                   `📅 Registrado: ${new Date(userInfo.registered_at).toLocaleDateString()}\n` +
                                   `📁 Archivos subidos: ${userFiles.length}`;
                
                bot.sendMessage(chatId, infoMessage, { parse_mode: 'Markdown' });
                break;
                
            case '📁 Mis archivos':
                const files = getUserFiles(user.id);
                
                if (files.length === 0) {
                    bot.sendMessage(chatId, '📭 *No tienes archivos guardados.*\n\nEnvía cualquier archivo para guardarlo.', {
                        parse_mode: 'Markdown'
                    });
                } else {
                    let filesMessage = `📂 *Tus archivos guardados (${files.length}):*\n\n`;
                    
                    files.slice(0, 10).forEach((file, index) => {
                        filesMessage += `${index + 1}. 📄 ${file.file_name}\n` +
                                       `   📦 Tipo: ${file.file_type}\n` +
                                       `   💾 ${(file.file_size / 1024).toFixed(2)} KB\n` +
                                       `   📅 ${new Date(file.uploaded_at).toLocaleDateString()}\n\n`;
                    });
                    
                    if (files.length > 10) {
                        filesMessage += `\n... y ${files.length - 10} archivos más.`;
                    }
                    
                    bot.sendMessage(chatId, filesMessage, { parse_mode: 'Markdown' });
                }
                break;
                
            case '📤 Subir archivo':
                const uploadMessage = `📤 *Subir archivo*\n\n` +
                                    `Puedes enviar:\n` +
                                    `• 📄 Documentos (PDF, Word, Excel, etc.)\n` +
                                    `• 🖼️ Fotos\n` +
                                    `• 🎥 Videos\n` +
                                    `• 🎵 Audio\n` +
                                    `• 📦 Otros archivos\n\n` +
                                    `*Simplemente envía el archivo que deseas guardar.*`;
                
                bot.sendMessage(chatId, uploadMessage, { parse_mode: 'Markdown' });
                break;
                
            case '🔁 Estado del Bot':
            case '🆘 Ayuda':
                const helpMessage = `🆘 *Centro de ayuda*\n\n` +
                                   `*Comandos disponibles:*\n` +
                                   `• /start - Iniciar el bot\n` +
                                   `• /status - Ver estado del bot\n` +
                                   `• /repair - Reparar base de datos (admin)\n\n` +
                                   `*Opciones del menú:*\n` +
                                   `• 📊 Ver mi información - Ver tus datos\n` +
                                   `• 📁 Mis archivos - Ver archivos guardados\n` +
                                   `• 📤 Subir archivo - Instrucciones para subir\n` +
                                   `• 🔁 Estado del Bot - Información del sistema`;
                
                bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
                break;
                
            case '⚙️ Configuración':
                bot.sendMessage(chatId, '⚙️ *Configuración*\n\nPróximamente más opciones...', {
                    parse_mode: 'Markdown'
                });
                break;
                
            default:
                sendMainMenu(chatId, user.first_name);
        }
    } catch (error) {
        console.error('❌ Error procesando mensaje:', error);
        bot.sendMessage(chatId, '❌ Ocurrió un error procesando tu solicitud. Intenta nuevamente.');
    }
});

// ==================== MANEJO DE ERRORES ====================

bot.on('polling_error', (error) => {
    console.error('🔴 Error de Polling:', error.message);
    
    if (error.message.includes('Cannot read properties of undefined')) {
        console.error('💥 Error crítico de base de datos. Ejecuta /repair para solucionarlo.');
        return;
    }
    
    isConnected = false;
    reconnectBot();
});

bot.on('webhook_error', (error) => {
    console.error('🔴 Error de Webhook:', error.message);
});

bot.on('error', (error) => {
    console.error('🔴 Error general del bot:', error.message);
});

bot.on('polling_start', () => {
    isConnected = true;
    reconnectAttempts = 0;
    console.log('✅ Polling iniciado correctamente');
});

// ==================== INICIALIZACIÓN ====================

// createDirectories();
 showStartupStats();

console.log('🤖 Bot iniciado correctamente!');
console.log('📊 Base de datos:', DB_PATH);
console.log('📁 Descargas:', DOWNLOADS_DIR);
console.log('⏳ Esperando mensajes...');

process.on('SIGINT', async () => {
    console.log('\n👋 Cerrando bot gracefulmente...');
    try {
        bot.stopPolling();
        console.log('✅ Bot detenido correctamente');
    } catch (error) {
        console.error('❌ Error al detener el bot:', error.message);
    }
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('💥 Excepción no capturada:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Promesa rechazada no manejada:', reason);
});