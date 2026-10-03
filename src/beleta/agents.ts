import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDef } from '../ai-core/index.js';

export function loadAgents(dir: string): { salesManager: AgentDef; communication: AgentDef; scout: AgentDef } {
  const common = readFileSync(join(dir, '_common.md'), 'utf8');
  const prompt = (f: string) => `${readFileSync(join(dir, f), 'utf8')}\n\n${common}`;

  const product: AgentDef = { name: 'PRODUCT_AGENT', instructions: prompt('product-agent.md'),
    tools: ['search_products', 'get_product', 'get_price', 'check_stock'] };
  const technical: AgentDef = { name: 'TECHNICAL_AGENT', instructions: prompt('technical-agent.md'),
    tools: ['search_knowledge', 'get_product'] };
  const calculation: AgentDef = { name: 'CALCULATION_AGENT', instructions: prompt('calculation-agent.md'),
    tools: ['calculate_material', 'calculate_accessories', 'calculate_shipping', 'get_price', 'check_stock'] };
  const lead: AgentDef = { name: 'LEAD_AGENT', instructions: prompt('lead-agent.md'),
    tools: ['create_customer', 'create_lead', 'update_lead', 'create_project', 'update_project', 'create_quote', 'update_quote', 'create_followup', 'request_human_approval'] };
  const communication: AgentDef = { name: 'COMMUNICATION_AGENT', instructions: prompt('communication-agent.md'),
    tools: ['send_email', 'create_followup', 'get_price', 'check_stock'] };

  // Sales Manager nemá žádný datový nástroj – jen delegace a eskalace na člověka.
  const salesManager: AgentDef = {
    name: 'SALES_MANAGER', instructions: prompt('sales-manager.md'), tools: ['request_human_approval'],
    delegates: {
      product: { agent: product, description: 'Produkty, ceny a sklad. Zadejte, co hledat.' },
      technical: { agent: technical, description: 'Technické dotazy a dokumentace.' },
      calculation: { agent: calculation, description: 'Výpočet materiálu, příslušenství a dopravy (uveďte produkt, plochu, PSČ).' },
      lead: { agent: lead, description: 'Uložení zákazníka/leadu/projektu, návrh nabídky, follow-up (uveďte všechny údaje od zákazníka).' },
      communication: { agent: communication, description: 'Příprava e-mailu zákazníkovi (uveďte customer_id a obsah).' },
    },
  };
  const scout: AgentDef = { name: 'OPPORTUNITY_SCOUT', instructions: prompt('opportunity-scout.md'), tools: ['create_opportunity'] };
  return { salesManager, communication, scout };
}
