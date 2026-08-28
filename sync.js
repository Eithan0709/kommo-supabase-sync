require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const kommo = axios.create({
  baseURL: `https://${process.env.KOMMO_SUBDOMAIN}.kommo.com/api/v4`,
  headers: {
    Authorization: `Bearer ${process.env.KOMMO_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===== IDs de campos personalizados =====
const FIELDS = {
  phone: 138374,
  utm_content: 138382,
  utm_campaign: 138386,
  utm_source: 138388,
  lead_calificado: 169906,
  asistio_reunion: 208170,
  meta_id: 269272,
  // === NUEVOS CAMPOS EXCEL / KOMMO ===
  ciudad_origen: null,   // Poné el ID numérico cuando lo tengas (ej: 123456)
  rubro: null,           // Poné el ID numérico cuando lo tengas
  horario_mensaje: null, // Poné el ID numérico cuando lo tengas
  hablo_problema: null,  // Poné el ID numérico cuando lo tengas
  valoracion: null,      // Poné el ID numérico cuando lo tengas
};

function getCustomFieldValue(entity, fieldIdOrCode) {
  if (!entity || !fieldIdOrCode) return null;
  const fields = entity?.custom_fields_values || [];
  const field = fields.find(
    (f) => f.field_id === Number(fieldIdOrCode) || f.field_code === fieldIdOrCode
  );
  if (!field || !field.values || !field.values.length) return null;
  const val = field.values[0].value;
  return val !== null && val !== undefined ? String(val) : null;
}

function getPhone(contact) {
  if (!contact?.custom_fields_values) return null;
  const phoneField = contact.custom_fields_values.find(
    (f) => f.field_id === FIELDS.phone || f.field_code === 'PHONE'
  );
  if (!phoneField?.values?.length) return null;
  return String(phoneField.values[0].value || '').replace(/\D/g, '') || null;
}

function isYes(value) {
  if (value === null || value === undefined) return false;
  const v = String(value).toLowerCase().trim();
  return v === 'sí' || v === 'si' || v === 'yes' || v === '1' || v === 'true';
}

async function getAllLeads() {
  let page = 1;
  let allLeads = [];
  let hasMore = true;

  while (hasMore) {
    const { data } = await kommo.get('/leads', {
      params: {
        with: 'contacts,custom_fields',
        limit: 250,
        page,
      },
    });
    const leads = data._embedded?.leads || [];
    allLeads = allLeads.concat(leads);
    hasMore = leads.length === 250;
    page++;
  }
  return allLeads;
}

async function getAllContacts() {
  const map = {};
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data } = await kommo.get('/contacts', {
      params: { 
        with: 'custom_fields', 
        limit: 250, 
        page 
      },
    });
    const contacts = data._embedded?.contacts || [];
    contacts.forEach((c) => (map[c.id] = c));
    hasMore = contacts.length === 250;
    page++;
  }
  return map;
}

async function sync() {
  console.log('Iniciando sincronización...\n');

  const leads = await getAllLeads();
  const contactsMap = await getAllContacts();

  const rows = [];

  for (const lead of leads) {
    const mainContactId =
      lead._embedded?.contacts?.find((c) => c.is_main)?.id ||
      lead._embedded?.contacts?.[0]?.id;

    const contact = mainContactId ? contactsMap[mainContactId] : null;
    if (!contact) continue;

    const telefono = getPhone(contact);
    if (!telefono) continue;

    const nombre = contact.name || lead.name || 'Sin nombre';
    const fecha = lead.created_at
      ? new Date(lead.created_at * 1000).toISOString()
      : null;

    const redSocial = getCustomFieldValue(lead, FIELDS.utm_source) || getCustomFieldValue(contact, FIELDS.utm_source) || 'N/A';
    const utmContent = getCustomFieldValue(lead, FIELDS.utm_content) || getCustomFieldValue(contact, FIELDS.utm_content) || 'N/A';
    const utmCampaign = getCustomFieldValue(lead, FIELDS.utm_campaign) || getCustomFieldValue(contact, FIELDS.utm_campaign) || 'N/A';
    const metaIdValue = getCustomFieldValue(lead, FIELDS.meta_id) || getCustomFieldValue(contact, FIELDS.meta_id) || 'N/A';

    // Lectura de los nuevos campos desde Kommo
    const ciudadOrigen = getCustomFieldValue(lead, FIELDS.ciudad_origen) || getCustomFieldValue(contact, FIELDS.ciudad_origen) || 'N/A';
    const rubroVal = getCustomFieldValue(lead, FIELDS.rubro) || getCustomFieldValue(contact, FIELDS.rubro) || 'N/A';
    const horarioMsj = getCustomFieldValue(lead, FIELDS.horario_mensaje) || getCustomFieldValue(contact, FIELDS.horario_mensaje) || '';
    const habloProb = getCustomFieldValue(lead, FIELDS.hablo_problema) || getCustomFieldValue(contact, FIELDS.hablo_problema) || 'NO';
    const valoracionVal = getCustomFieldValue(lead, FIELDS.valoracion) || getCustomFieldValue(contact, FIELDS.valoracion) || 'Sin Valorar';

    const row = {
      telefono,
      nombre,
      lead_calificado: isYes(getCustomFieldValue(lead, FIELDS.lead_calificado)) || isYes(getCustomFieldValue(contact, FIELDS.lead_calificado)),
      asistio_reunion: isYes(getCustomFieldValue(lead, FIELDS.asistio_reunion)) || isYes(getCustomFieldValue(contact, FIELDS.asistio_reunion)),
      lead_ganado: false,
      anuncio_proveniencia: utmCampaign,
      fecha_hora_contacto: fecha,
      meta_id: String(metaIdValue),
      utm_campaign: utmCampaign,
      utm_content: utmContent,
      red_meta: redSocial,
      kommo_lead_id: lead.id,
      // === NUEVAS COLUMNAS PARA SUPABASE Y EL DASHBOARD ===
      ciudad_origen: ciudadOrigen,
      rubro: rubroVal,
      horario_mensaje: horarioMsj,
      hablo_problema: habloProb,
      valoracion: valoracionVal,
      updated_at: new Date().toISOString(),
    };

    rows.push(row);
  }

  const batchSize = 150;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from('leads_kommo')
      .upsert(batch, { onConflict: 'telefono' });

    if (error) {
      console.error('Error en lote:', error.message);
    } else {
      console.log(`Lote ${Math.floor(i / batchSize) + 1} subido (${batch.length} filas)`);
    }
  }

  fs.writeFileSync('datos.json', JSON.stringify(rows, null, 2));
  console.log('Archivo datos.json actualizado con las nuevas columnas.');
}

// ===== PROGRAMACIÓN DE SINCRONIZACIÓN =====
const MINUTOS = 15;
const INTERVALO_MS = MINUTOS * 60 * 1000;

function mostrarProximaHora() {
  const ahora = new Date();
  const proxima = new Date(ahora.getTime() + INTERVALO_MS);
  
  const horaSiguiente = proxima.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });

  console.log(`\n==================================================`);
  console.log(`[${ahora.toLocaleTimeString('es-ES', { hour12: true })}] Sincronización completada.`);
  console.log(`>> PRÓXIMA ACTUALIZACIÓN A LAS: ${horaSiguiente} <<`);
  console.log(`==================================================\n`);
}

async function iniciarCiclo() {
  await sync();
  mostrarProximaHora();
}

// Primera ejecución al arrancar
iniciarCiclo();

// Ciclo automático cada 15 minutos
setInterval(() => {
  iniciarCiclo();
}, INTERVALO_MS);