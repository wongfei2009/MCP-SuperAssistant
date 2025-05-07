// AI Studio website components for MCP-SuperAssistant
// Provides toggle buttons (MCP, Auto Insert, Auto Submit, Auto Execute) and state management

import React from 'react';
import ReactDOM from 'react-dom/client';
import { MCPPopover } from '../../components/mcpPopover/mcpPopover';
import type { AdapterConfig, SimpleSiteAdapter } from './common';
import { initializeAdapter, ToggleStateManager, MCPToggleState } from './common';

// Keep AI Studio-specific functions or overrides

// Find where to insert the MCP popover in AI Studio UI
function findAIStudioButtonInsertionPoint(): { container: Element; insertAfter: Element | null } | null {
  // Find the main prompt input wrapper
  const promptInputWrapper = document.querySelector('.prompt-input-wrapper'); // Adjust selector if needed
  if (!promptInputWrapper) {
    console.warn('[AIStudio Adapter] Could not find .prompt-input-wrapper');
    // Add more specific fallbacks if the structure varies
    const fallback = document.querySelector('footer .actions-container'); // Example fallback
    if (fallback) {
      console.debug('[AIStudio Adapter] Found fallback insertion point: footer .actions-container');
      return { container: fallback, insertAfter: null }; // Append
    }
    return null;
  }
  console.debug('[AIStudio Adapter] Found insertion point: .prompt-input-wrapper');

  // Find all .button-wrapper elements inside the prompt input wrapper
  const buttonWrappers = promptInputWrapper.querySelectorAll('.button-wrapper'); // Adjust selector if needed
  if (buttonWrappers.length > 0) {
    // Insert after the last button-wrapper
    const lastButtonWrapper = buttonWrappers[buttonWrappers.length - 1];
    return { container: promptInputWrapper, insertAfter: lastButtonWrapper };
  }

  // Fallback: just insert at the end of the prompt input wrapper if no button wrappers found
  return { container: promptInputWrapper, insertAfter: null };
}

// AI Studio-specific sidebar handling (assuming similar to Gemini/common)
function showAIStudioSidebar(adapter: SimpleSiteAdapter | null): void {
  console.debug('[AIStudio Adapter] MCP Enabled - Showing sidebar');
  if (adapter?.showSidebarWithToolOutputs) {
    adapter.showSidebarWithToolOutputs();
  } else if (adapter?.toggleSidebar) {
    adapter.toggleSidebar(); // Fallback
  } else {
    console.warn('[AIStudio Adapter] No method found to show sidebar.');
  }
}

function hideAIStudioSidebar(adapter: SimpleSiteAdapter | null): void {
  console.debug('[AIStudio Adapter] MCP Disabled - Hiding sidebar');
  if (adapter?.hideSidebar) {
    adapter.hideSidebar();
  } else if (adapter?.sidebarManager?.hide) {
    adapter.sidebarManager.hide();
  } else if (adapter?.toggleSidebar) {
    adapter.toggleSidebar(); // Fallback
  } else {
    console.warn('[AIStudio Adapter] No method found to hide sidebar.');
  }
}

// AI Studio Adapter Configuration
const aiStudioAdapterConfig: AdapterConfig = {
  adapterName: 'AiStudio', // Ensure this matches adapter.name check in common handlers
  storageKeyPrefix: 'mcp-aistudio-state', // Uses localStorage
  findButtonInsertionPoint: findAIStudioButtonInsertionPoint,
  getStorage: () => localStorage, // AI Studio uses localStorage
  
  // Override URL key generation to use a fixed key for all AI Studio chats
  // This ensures toggle state is shared across all AI Studio chat sessions
  getCurrentURLKey: () => {
    // Return a fixed string instead of the path to make settings consistent across all chats
    return 'global-settings';
  },
  
  onMCPEnabled: showAIStudioSidebar,
  onMCPDisabled: hideAIStudioSidebar,
};

// Initialize AI Studio components using the common initializer
export function initAIStudioComponents(): void {
  console.debug('Initializing AI Studio MCP components using common framework');
  const stateManager = initializeAdapter(aiStudioAdapterConfig);

  // Expose manual injection for debugging (optional)
  window.injectMCPButtons = () => {
    console.debug('Manual injection for AI Studio triggered');
    const insertFn = (window as any)[`injectMCPButtons_${aiStudioAdapterConfig.adapterName}`];
    if (insertFn) {
      insertFn();
    } else {
      console.warn('Manual injection function not found.');
    }
  };

  console.debug('AI Studio MCP components initialization complete.');
}
