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
};

// Función auxiliar para obtener el valor de un Custom Field (admite Lead o Contacto)
function getCustomFieldValue(entity, fieldIdOrCode) {
  if (!entity || !fieldIdOrCode) return null;
  const fields = entity?.custom_fields_values || [];
  const field = fields.find(
    (f) => f.field_id === Number(fieldIdOrCode) || f.field_code === fieldIdOrCode
  );
  
  if (!field || !field.values || !field.values.length) return null;

  // Convierte el valor a String sin importar si viene como número, texto o enum
  const val = field.values[0].value;
  return val !== null && val !== undefined ? String(val) : null;
}

function obtenerProximaEjecucion(minutos) {
  const ahora = new Date();
  ahora.setMinutes(ahora.getMinutes() + minutos);
  return ahora.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
        with: 'contacts,custom_fields', // Incluye los contactos vinculados y los custom fields del lead
        limit: 250,
        page,
      },
    });

    const leads = data._embedded?.leads || [];
    allLeads = allLeads.concat(leads);
    console.log(`Página ${page}: ${leads.length} leads`);
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
        with: 'custom_fields', // Incluye los custom fields del contacto
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
  console.log(`Total leads encontrados: ${leads.length}`);

  const contactsMap = await getAllContacts();
  console.log(`Total contactos encontrados: ${Object.keys(contactsMap).length}\n`);

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
      updated_at: new Date().toISOString(),
    };

    rows.push(row);
  }

  console.log(`Filas listas para sincronizar: ${rows.length}\n`);

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
  console.log('Archivo datos.json actualizado para el HTML.');

  const MINUTOS_INTERVALO = 15;
  const proximaHora = obtenerProximaEjecucion(MINUTOS_INTERVALO);

  console.log('¡Sincronización terminada!');
  console.log(`Próxima actualización programada a las: ${proximaHora}\n`);
}

const MINUTOS = 15;
const INTERVALO_MS = MINUTOS * 60 * 1000;

// Ejecución inicial y programación de intervalo
sync();

setInterval(() => {
  console.log(`\n[${new Date().toLocaleTimeString()}] Iniciando sincronización programada...`);
  sync();
}, INTERVALO_MS);