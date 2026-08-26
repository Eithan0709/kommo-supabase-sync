require('dotenv').config();
const axios = require('axios');

const kommo = axios.create({
  baseURL: `https://${process.env.KOMMO_SUBDOMAIN}.kommo.com/api/v4`,
  headers: { 
    Authorization: `Bearer ${process.env.KOMMO_TOKEN}`,
    'Content-Type': 'application/json'
  },
});

(async () => {
  try {
    console.log('Consultando campos en Kommo...\n');

    // 1. Obtener campos de Leads
    const resLeads = await kommo.get('/leads/custom_fields');
    const fieldsLeads = resLeads.data._embedded?.custom_fields || [];
    
    console.log('=== CAMPOS DE LEADS ===');
    fieldsLeads.forEach(f => {
      console.log(`ID: ${f.id} | Nombre: "${f.name}" | Código: ${f.code || 'Sin código'}`);
    });

    // 2. Obtener campos de Contactos
    const resContacts = await kommo.get('/contacts/custom_fields');
    const fieldsContacts = resContacts.data._embedded?.custom_fields || [];

    console.log('\n=== CAMPOS DE CONTACTOS ===');
    fieldsContacts.forEach(f => {
      console.log(`ID: ${f.id} | Nombre: "${f.name}" | Código: ${f.code || 'Sin código'}`);
    });

  } catch (error) {
    console.error('Error al consultar la API de Kommo:');
    if (error.response) {
      console.error(`Estado HTTP: ${error.response.status}`);
      console.error('Detalle:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
  }
})();