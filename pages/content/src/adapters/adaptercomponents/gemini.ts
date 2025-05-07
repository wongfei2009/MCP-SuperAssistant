// Gemini website components for MCP-SuperAssistant
// Provides toggle buttons (MCP, Auto Insert, Auto Submit, Auto Execute) and state management

// import React from 'react';
// import ReactDOM from 'react-dom/client';
// import { MCPPopover } from '../../components/mcpPopover/mcpPopover';
import type { AdapterConfig, SimpleSiteAdapter } from './common';
import { initializeAdapter } from './common';

// Keep Gemini-specific functions or overrides

// Find where to insert in Gemini UI
function findGeminiButtonInsertionPoint(): { container: Element; insertAfter: Element | null } | null {
  // Try the primary selector first
  const wrapper = document.querySelector('.leading-actions-wrapper');
  if (wrapper) {
    console.debug('[Gemini Adapter] Found insertion point: .leading-actions-wrapper');
    // Try to insert after the second button for better placement
    const btns = wrapper.querySelectorAll('button');
    const after = btns.length > 1 ? btns[1] : btns.length > 0 ? btns[0] : null;
    return { container: wrapper, insertAfter: after };
  }

  // Fallback selector (example, adjust if needed)
  const fallbackContainer = document.querySelector('.input-area .actions');
  if (fallbackContainer) {
    console.debug('[Gemini Adapter] Found fallback insertion point: .input-area .actions');
    return { container: fallbackContainer, insertAfter: null }; // Append
  }

  console.warn('[Gemini Adapter] Could not find a suitable insertion point.');
  return null;
}

// Gemini-specific sidebar handling
function showGeminiSidebar(adapter: SimpleSiteAdapter | null): void {
  console.debug('[Gemini Adapter] MCP Enabled - Showing sidebar');
  if (adapter?.showSidebarWithToolOutputs) {
    adapter.showSidebarWithToolOutputs();
  } else {
    console.warn('[Gemini Adapter] No method found to show sidebar.');
  }
}

function hideGeminiSidebar(adapter: SimpleSiteAdapter | null): void {
  console.debug('[Gemini Adapter] MCP Disabled - Hiding sidebar');
  if (adapter?.hideSidebar) {
    adapter.hideSidebar();
  } else if (adapter?.sidebarManager?.hide) {
    adapter.sidebarManager.hide();
  } else if (adapter?.toggleSidebar) {
    adapter.toggleSidebar(); // Fallback
  } else {
    console.warn('[Gemini Adapter] No method found to hide sidebar.');
  }
}

// Gemini Adapter Configuration
const geminiAdapterConfig: AdapterConfig = {
  adapterName: 'Gemini',
  storageKeyPrefix: 'mcp-gemini-state', // Uses localStorage, prefix + URL path
  findButtonInsertionPoint: findGeminiButtonInsertionPoint,
  getStorage: () => localStorage, // Gemini uses localStorage
  
  // Override URL key generation to use a fixed key for all Gemini chats
  // This ensures toggle state is shared across all Gemini chat sessions
  getCurrentURLKey: () => {
    // Return a fixed string instead of the path to make settings consistent across all chats
    return 'global-settings';
  },
  
  onMCPEnabled: showGeminiSidebar,
  onMCPDisabled: hideGeminiSidebar,
};

// Initialize Gemini components using the common initializer
export function initGeminiComponents(): void {
  console.debug('Initializing Gemini MCP components using common framework');
  const stateManager = initializeAdapter(geminiAdapterConfig);

  // Expose manual injection for debugging (optional)
  window.injectMCPButtons = () => {
    console.debug('Manual injection for Gemini triggered');
    const insertFn = (window as any)[`injectMCPButtons_${geminiAdapterConfig.adapterName}`];
    if (insertFn) {
      insertFn();
    } else {
      console.warn('Manual injection function not found.');
    }
  };

  console.debug('Gemini MCP components initialization complete.');
}
