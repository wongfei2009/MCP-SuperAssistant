import { CONFIG } from '../core/config';
import { containsFunctionCalls, extractLanguageTag } from '../parser/index';
import { safelySetContent } from '../utils/index';
import {
  addRawXmlToggle,
  addExecuteButton,
  setupAutoScroll,
  smoothlyUpdateBlockContent,
  extractFunctionParameters,
} from './components';
import { applyThemeClass } from '../utils/themeDetector';
import { getPreviousExecution, getPreviousExecutionLegacy, generateContentSignature } from '../mcpexecute/storage';
import type { ParamValueElement } from '../core/types';

// Define custom property for tracking scroll state
declare global {
  interface HTMLElement {
    _userHasScrolled?: boolean;
  }
}

// Monaco editor CSP-compatible configuration
const configureMonacoEditorForCSP = () => {
  if (typeof window !== 'undefined' && (window as any).monaco) {
    try {
      // Override worker creation to disable web workers
      // This is not ideal for performance but allows Monaco to work in strict CSP environments
      (window as any).monaco.editor.onDidCreateEditor((editor: any) => {
        // Disable worker-based features
        editor.updateOptions({
          wordBasedSuggestions: false,
          snippetSuggestions: false,
          suggestOnTriggerCharacters: false,
          semanticHighlighting: { enabled: false },
          codeLens: false,
          formatOnType: false,
          folding: false,
        });
      });

      // Override Monaco environment worker URL generation
      (window as any).MonacoEnvironment = {
        getWorkerUrl: function () {
          // Return a script that defines a no-op worker
          return 'data:text/javascript;charset=utf-8,console.debug("Monaco worker disabled for CSP compatibility");';
        },
      };

      console.debug('Monaco editor configured for CSP compatibility');
    } catch (e) {
      console.error('Failed to configure Monaco editor for CSP:', e);
    }
  }
};

// State management for rendered elements
export const processedElements = new WeakSet<HTMLElement>();
export const renderedFunctionBlocks = new Map<string, HTMLDivElement>();

// Default auto-execution setting if not specified by user
const DEFAULT_AUTO_EXECUTE = true;

// Maximum number of retry attempts before giving up on auto-execution
const MAX_AUTO_EXECUTE_ATTEMPTS = 8;

// Default delay between auto-execution attempts (ms)
const AUTO_EXECUTE_RETRY_DELAY = 300;

// Initial delay before first auto-execution attempt (ms)
const INITIAL_AUTO_EXECUTE_DELAY = 150;

// Setup a global mutation observer to watch for DOM changes
// This helps with detecting when function blocks are added or modified
let domObserver: MutationObserver | null = null;
let observerEnabled = false;

// Function to setup the DOM observer
const setupDOMObserver = () => {
  // If already set up and enabled, do nothing
  if (domObserver && observerEnabled) return;

  // Clean up existing observer if any
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
  
  // Create and configure the new observer
  domObserver = new MutationObserver((mutations) => {
    // Only process mutations if observer is enabled
    if (!observerEnabled) return;
    
    let functionBlocksToProcess = [];
    
    // First pass: collect all function blocks to process
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            
            // Find unprocessed function blocks
            const blocks = element.querySelectorAll 
              ? element.querySelectorAll<HTMLPreElement>('pre:not([data-processed])')
              : [];
              
            for (const block of Array.from(blocks)) {
              // Mark as being processed to prevent duplicates
              block.setAttribute('data-processed', 'true');
              
              // Only add blocks that contain function calls and aren't already processed
              if (!processedElements.has(block) && 
                  block.textContent?.includes('<function_calls>')) {
                functionBlocksToProcess.push(block);
              }
            }
          }
        }
      }
    }
    
    // Second pass: process all blocks with a delay between each
    if (functionBlocksToProcess.length > 0) {
      console.debug(`DOM Observer: Found ${functionBlocksToProcess.length} function blocks to process`);
      
      // Temporarily disable observer during processing to prevent interference
      const currentObserverStatus = observerEnabled;
      observerEnabled = false;
      
      // Process blocks one at a time with delay between to avoid race conditions
      functionBlocksToProcess.forEach((block, index) => {
        setTimeout(() => {
          try {
            console.debug(`DOM Observer: Processing block ${index + 1}/${functionBlocksToProcess.length}`);
            renderFunctionCall(block, { current: false });
          } catch (error) {
            console.error(`Error processing function block ${index + 1}:`, error);
          }
          
          // Re-enable observer after last block is processed
          if (index === functionBlocksToProcess.length - 1) {
            setTimeout(() => {
              observerEnabled = currentObserverStatus;
              console.debug('DOM Observer: Re-enabled after processing');
            }, 100);
          }
        }, index * 100); // Stagger processing by 100ms per block
      });
    }
  });

  // Start observing the entire document
  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
  
  // Mark observer as enabled
  observerEnabled = true;
  console.debug('DOM Observer: Setup complete and enabled');
};

// Enable/disable the observer
export const enableDOMObserver = () => {
  observerEnabled = true;
  console.debug('DOM Observer: Enabled');
};

export const disableDOMObserver = () => {
  observerEnabled = false;
  console.debug('DOM Observer: Disabled');
};

/**
 * Global scanner that actively looks for and executes eligible function buttons
 * This is the primary mechanism that ensures reliable auto-execution
 * But it respects the user's auto-execute toggle preference
 */
const autoExecuteButtonScanner = () => {
  // Check if auto-execute is enabled by the user
  const autoExecuteEnabled = (window as any).toggleState?.autoExecute === true;
  
  if (CONFIG.debug) console.debug(`Auto-execute scanner running (enabled: ${autoExecuteEnabled})`);
  
  // Find all execute buttons on the page
  const allButtons = document.querySelectorAll<HTMLButtonElement>('.execute-button');
  
  if (allButtons.length === 0) {
    // Schedule another check if no buttons found
    setTimeout(autoExecuteButtonScanner, 1000);
    return;
  }
  
  // Only process buttons if auto-execute is enabled
  if (autoExecuteEnabled) {
    // Process each button
    allButtons.forEach((button, index) => {
      // Skip disabled buttons or ones already processed
      if (button.disabled || button.getAttribute('data-auto-exec-ready') === 'false') {
        return;
      }
      
      // Get function name for logging
      const block = button.closest('.function-block');
      const nameEl = block?.querySelector('.function-name-text');
      const functionName = nameEl?.textContent || 'unknown';
      
      // Delay increases with button index to avoid overwhelming the page
      const delay = 300 * (index + 1);
      
      if (CONFIG.debug) console.debug(`Scheduling auto-execution for ${functionName} in ${delay}ms`);
      
      setTimeout(() => {
        try {
          // Check again if auto-execute is still enabled at execution time
          const stillEnabled = (window as any).toggleState?.autoExecute === true;
          
          // Final check before clicking
          if (stillEnabled && !button.disabled && button.getAttribute('data-auto-exec-ready') !== 'false') {
            if (CONFIG.debug) console.debug(`Auto-executing function ${functionName}`);
            button.click();
          }
        } catch (e) {
          console.error(`Error auto-executing ${functionName}:`, e);
        }
      }, delay);
    });
  }
  
  // Continue scanning periodically to catch new buttons
  setTimeout(autoExecuteButtonScanner, 3000);
};

// Setup the observer and auto-execution scanner when the module loads
if (typeof window !== 'undefined') {
  // Wait for DOM to be ready before setting up
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(setupDOMObserver, 500); // Delayed setup for better stability
      setTimeout(autoExecuteButtonScanner, 1000); // Start auto-execution scan after 1 second
    });
  } else {
    setTimeout(setupDOMObserver, 500); // Delayed setup for better stability
    setTimeout(autoExecuteButtonScanner, 1000); // Start auto-execution scan after 1 second
  }
}

// Centralized execution tracking system to prevent race conditions and duplicate executions
interface ExecutionTracker {
  // Track auto-execution attempts to prevent endless retries for removed blocks
  attempts: Map<string, number>;
  // Track blocks that have been successfully auto-executed or are in progress
  executed: Set<string>;
  // Track function call signatures (callId + contentSignature) that have been executed
  executedFunctions: Set<string>;
  // Check if a function has been executed or is scheduled for execution
  isFunctionExecuted(callId: string, contentSignature: string, functionName?: string): boolean;
  // Mark a function as executed or in progress
  markFunctionExecuted(callId: string, contentSignature: string, functionName?: string): void;
  // Check if a block has been auto-executed
  isBlockExecuted(blockId: string): boolean;
  // Mark a block as auto-executed
  markBlockExecuted(blockId: string): void;
  // Get attempts for a block
  getAttempts(blockId: string): number;
  // Increment attempts for a block
  incrementAttempts(blockId: string): number;
  // Clean up tracking data for a block
  cleanupBlock(blockId: string): void;
}

// Implementation of the execution tracker
export const executionTracker: ExecutionTracker = {
  attempts: new Map<string, number>(),
  executed: new Set<string>(),
  executedFunctions: new Set<string>(),

  isFunctionExecuted(callId: string, contentSignature: string, functionName?: string): boolean {
    // Create a unique log ID for tracing this specific check
    const checkId = Math.random().toString(36).substring(2, 8);
    console.debug(
      `[Debug][${checkId}] isFunctionExecuted called with: callId='${callId}', signature='${contentSignature}', funcName='${functionName || 'undefined'}'`,
    );

    // First check: Direct memory lookup with provided function name (most reliable)
    if (typeof functionName === 'string') {
      const key = `${functionName}:${callId}:${contentSignature}`;
      const inMemory = this.executedFunctions.has(key);
      
      // Storage check with provided function name
      const inStorage = getPreviousExecution(functionName, callId, contentSignature) !== null;
      
      console.debug(
        `[Debug][${checkId}] Standard Check: Key='${key}', inMemory=${inMemory}, inStorage=${inStorage}`,
      );
      
      if (inMemory || inStorage) {
        return true;
      }
    }
    
    // Second check: Try to extract function name from memory if not provided
    if (typeof functionName !== 'string') {
      for (const key of this.executedFunctions) {
        const parts = key.split(':');
        if (parts.length === 3 && parts[1] === callId && parts[2] === contentSignature) {
          const extractedName = parts[0];
          console.debug(`[Debug][${checkId}] Found functionName='${extractedName}' from executedFunctions set`);
          
          // Check storage using the extracted name
          const inStorage = getPreviousExecution(extractedName, callId, contentSignature) !== null;
          if (inStorage) {
            console.debug(`[Debug][${checkId}] Found execution in storage using extracted name`);
            return true;
          }
          
          // If in memory (which we already know is true), return true
          return true;
        }
      }
    }
    
    // Third check: Legacy check for backward compatibility
    const legacyKey = `${callId}:${contentSignature}`;
    const legacyKey2 = `:${callId}:${contentSignature}`;
    const inMemoryLegacy = this.executedFunctions.has(legacyKey) || this.executedFunctions.has(legacyKey2);
    const inStorageLegacy = getPreviousExecutionLegacy(callId, contentSignature) !== null;
    
    console.debug(
      `[Debug][${checkId}] Legacy Check: Key='${legacyKey}', inMemory=${inMemoryLegacy}, inStorage=${inStorageLegacy}`,
    );
    
    return inMemoryLegacy || inStorageLegacy;
  },

  markFunctionExecuted(callId: string, contentSignature: string, functionName?: string): void {
    // Create a standardized tracking ID for logging
    const trackingId = Math.random().toString(36).substring(2, 8);
    
    if (typeof functionName === 'string' && functionName.trim().length > 0) {
      // Standard case with function name
      const key = `${functionName}:${callId}:${contentSignature}`;
      this.executedFunctions.add(key);
      console.debug(`[Debug][${trackingId}] Marked function as executed: ${key}`);
    } else {
      // Legacy format for backward compatibility
      const key = `${callId}:${contentSignature}`;
      this.executedFunctions.add(key);
      console.debug(`[Debug][${trackingId}] Marked function as executed (legacy): ${key}`);
    }
    
    // Always update the latest execution timestamp
    (window as any).__lastExecutionTimestamp = Date.now();
  },

  isBlockExecuted(blockId: string): boolean {
    return this.executed.has(blockId) === true;
  },

  markBlockExecuted(blockId: string): void {
    this.executed.add(blockId);
  },

  getAttempts(blockId: string): number {
    return this.attempts.get(blockId) || 0;
  },

  incrementAttempts(blockId: string): number {
    const current = this.getAttempts(blockId);
    const newValue = current + 1;
    this.attempts.set(blockId, newValue);
    return newValue;
  },

  cleanupBlock(blockId: string): void {
    this.attempts.delete(blockId);
  },
};

/**
 * Main function to render a function call block
 *
 * @param block HTML element containing a function call
 * @param isProcessingRef Reference to processing state
 * @returns Boolean indicating whether rendering was successful
 */
// Configure Monaco once before rendering any blocks
if (typeof window !== 'undefined') {
  configureMonacoEditorForCSP();
}

export const renderFunctionCall = (block: HTMLPreElement, isProcessingRef: { current: boolean }): boolean => {
  const functionInfo = containsFunctionCalls(block);

  if (!functionInfo.hasFunctionCalls || block.closest('.function-block')) {
    return false;
  }

  const blockId =
    block.getAttribute('data-block-id') || `block-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // Get the set of pre-existing incomplete blocks if it exists
  const preExistingIncompleteBlocks = (window as any).preExistingIncompleteBlocks || new Set<string>();

  // Check if this is a pre-existing incomplete block that should not get spinners
  const isPreExistingIncomplete = preExistingIncompleteBlocks.has(blockId);

  let existingDiv = renderedFunctionBlocks.get(blockId);
  let isNewRender = false;
  let previousCompletionStatus: boolean | null = null;

  if (processedElements.has(block)) {
    if (!existingDiv) {
      const existingDivs = document.querySelectorAll<HTMLDivElement>(`.function-block[data-block-id="${blockId}"]`);
      if (existingDivs.length > 0) {
        existingDiv = existingDivs[0];
        renderedFunctionBlocks.set(blockId, existingDiv);
      } else {
        processedElements.delete(block);
      }
    }
  }

  if (!existingDiv) {
    isNewRender = true;
    if (!processedElements.has(block)) {
      processedElements.add(block);
      block.setAttribute('data-block-id', blockId);
    }
  } else {
    previousCompletionStatus = !existingDiv.classList.contains('function-loading');
  }

  const rawContent = block.textContent?.trim() || '';
  const { tag, content } = extractLanguageTag(rawContent);

  // CRITICAL: Use the existing div if available for streaming updates, or create a new one
  const blockDiv = existingDiv || document.createElement('div');

  // Only update these properties on a new render, not during streaming updates
  if (isNewRender) {
    blockDiv.className = 'function-block';
    blockDiv.setAttribute('data-block-id', blockId);

    // Apply theme class based on current theme
    applyThemeClass(blockDiv);

    // Register this block
    renderedFunctionBlocks.set(blockId, blockDiv);
  }

  // Handle state transitions when block completion status changes
  if (!isNewRender) {
    const justCompleted = previousCompletionStatus === false && functionInfo.isComplete;
    const justBecameIncomplete = previousCompletionStatus === true && !functionInfo.isComplete;

    if (justCompleted) {
      // Update UI state when transitioning from loading to complete
      blockDiv.classList.remove('function-loading');
      blockDiv.classList.add('function-complete');

      // Remove spinner if exists
      const spinner = blockDiv.querySelector('.spinner');
      if (spinner) {
        spinner.remove();
      }
    } else if (justBecameIncomplete) {
      // Update UI state when transitioning from complete to loading
      blockDiv.classList.remove('function-complete');
      blockDiv.classList.add('function-loading');
    }
  } else {
    // Only add loading state for new renders if not pre-existing incomplete
    if (!functionInfo.isComplete && !isPreExistingIncomplete) {
      blockDiv.classList.add('function-loading');
    }

    // Add language tag if needed for new renders
    if (tag || functionInfo.languageTag) {
      const langTag = document.createElement('div');
      langTag.className = 'language-tag';
      langTag.textContent = tag || functionInfo.languageTag;
      blockDiv.appendChild(langTag);
    }
  }

  // Extract function name from the raw content
  // Use regex to extract function name directly from content as a fallback for functionInfo
  const invokeMatch = content.match(/<invoke name="([^"]+)"(?:\s+call_id="([^"]+)")?>/i);
  const functionName = invokeMatch ? invokeMatch[1] : 'function';
  const callId = invokeMatch && invokeMatch[2] ? invokeMatch[2] : blockId;

  // Handle function name creation or update
  let functionNameElement = blockDiv.querySelector<HTMLDivElement>('.function-name');

  if (!functionNameElement) {
    // Create function name if not exists (new render)
    functionNameElement = document.createElement('div');
    functionNameElement.className = 'function-name';

    const functionNameText = document.createElement('span');
    functionNameText.className = 'function-name-text';
    functionNameText.textContent = functionName;
    functionNameElement.appendChild(functionNameText);

    // Add call ID to the function name element (positioned top right via CSS)
    if (callId) {
      const callIdElement = document.createElement('span');
      callIdElement.className = 'call-id';
      callIdElement.textContent = callId;
      functionNameElement.appendChild(callIdElement);
    }

    // If function is not complete and not a pre-existing incomplete block, add spinner
    if (!functionInfo.isComplete && !isPreExistingIncomplete) {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      functionNameElement.appendChild(spinner);
    }

    blockDiv.appendChild(functionNameElement);
  } else {
    // Update existing function name (streaming update)
    const nameText = functionNameElement.querySelector<HTMLSpanElement>('.function-name-text');
    if (nameText && nameText.textContent !== functionName) {
      nameText.textContent = functionName;
    }

    // Update call ID if needed
    const callIdElement = functionNameElement.querySelector<HTMLSpanElement>('.call-id');
    if (callId) {
      if (callIdElement) {
        if (callIdElement.textContent !== callId) {
          callIdElement.textContent = callId;
        }
      } else {
        const newCallId = document.createElement('span');
        newCallId.className = 'call-id';
        newCallId.textContent = callId;
        functionNameElement.appendChild(newCallId);
      }
    }
  }

  // Get existing or create a new parameter container
  let paramsContainer = blockDiv.querySelector<HTMLDivElement>('.function-params');

  if (!paramsContainer) {
    // Create parameter container if it doesn't exist
    paramsContainer = document.createElement('div');
    paramsContainer.className = 'function-params';
    paramsContainer.style.display = 'flex';
    paramsContainer.style.flexDirection = 'column';
    paramsContainer.style.gap = '4px';
    paramsContainer.style.width = '100%';
    blockDiv.appendChild(paramsContainer);
  }

  // --- START: Incremental Parameter Parsing and Rendering ---
  const partialParameters: Record<string, string> = {};
  const paramStartRegex = /<parameter\s+name="([^"]+)"[^>]*>/gs;
  let match;
  while ((match = paramStartRegex.exec(rawContent)) !== null) {
    const paramName = match[1];
    const startIndex = match.index + match[0].length;
    const endTag = '</parameter>';
    const endTagIndex = rawContent.indexOf(endTag, startIndex);

    let extractedValue = '';
    // Determine if parameter is complete (has ending tag) or still streaming
    const isParamStreaming = endTagIndex === -1;
    if (!isParamStreaming) {
      // Full parameter content available (within the current rawContent)
      extractedValue = rawContent.substring(startIndex, endTagIndex);
    } else {
      // Partial parameter content (streaming)
      extractedValue = rawContent.substring(startIndex);
    }

    // Handle potential CDATA within the extracted value
    const cdataMatch = extractedValue.match(/<!\[CDATA\[(.*?)(?:\]\]>)?$/s);
    if (cdataMatch) {
      // Use CDATA content, remove partial end tag if streaming
      extractedValue = cdataMatch[1];
    } else {
      // Trim only if not CDATA, as CDATA preserves whitespace
      extractedValue = extractedValue.trim();
    }

    partialParameters[paramName] = extractedValue;

    // Create or update the parameter - use the found/created params container
    // If paramsContainer doesn't exist, this will still work by using document-level lookup
    createOrUpdateParamElement(paramsContainer!, paramName, extractedValue, blockId, isNewRender, isParamStreaming);
  }
  // --- END: Incremental Parameter Parsing and Rendering ---

  // Extract *complete* parameters using the function from components.ts *only when needed*
  let completeParameters: Record<string, any> | null = null;
  if (functionInfo.isComplete) {
    completeParameters = extractFunctionParameters(rawContent);
  }

  // Generate content signature *only* when complete
  let contentSignature: string | null = null;
  if (functionInfo.isComplete && completeParameters) {
    contentSignature = generateContentSignature(functionName, completeParameters);
  }

  // Only replace the original element with our render if this is a new render
  if (isNewRender) {
    if (block.parentNode) {
      block.parentNode.insertBefore(blockDiv, block);
      block.style.display = 'none';
    } else {
      if (CONFIG.debug) console.warn('Function call block has no parent element, cannot insert rendered block');
      return false;
    }
  }

  // Create a button container if it doesn't exist
  let buttonContainer = blockDiv.querySelector<HTMLDivElement>('.function-buttons');
  if (!buttonContainer) {
    // Create a container for the buttons
    buttonContainer = document.createElement('div');
    buttonContainer.className = 'function-buttons';
    blockDiv.appendChild(buttonContainer);

    // Add spacing between parameters and buttons
    const spacer = document.createElement('div');
    spacer.style.height = '8px';
    blockDiv.insertBefore(spacer, buttonContainer);
  }

  // Add a raw XML toggle if the function is complete
  if (functionInfo.isComplete && !blockDiv.querySelector('.raw-toggle')) {
    // If we're using the button container, pass it instead of blockDiv
    if (buttonContainer) {
      addRawXmlToggle(buttonContainer, rawContent);
    } else {
      addRawXmlToggle(blockDiv, rawContent);
    }
  }

  // Add execute button if the function is complete and not already added
  if (functionInfo.isComplete && !blockDiv.querySelector('.execute-button')) {
    // Ensure completeParameters is available before adding button/setting up auto-exec
    if (!completeParameters) {
      completeParameters = extractFunctionParameters(rawContent);
    }
    // If we're using the button container, pass it instead of blockDiv
    if (buttonContainer) {
      addExecuteButton(buttonContainer, rawContent); // rawContent has full data here
    } else {
      addExecuteButton(blockDiv, rawContent);
    }

    // Check if auto-execute is enabled in user settings
    // Ensure toggleState exists but don't override user preference
    (window as any).toggleState = (window as any).toggleState || {};
    
    // If toggleState.autoExecute is undefined, use the default
    // If it's explicitly set (true or false), respect that setting
    if ((window as any).toggleState.autoExecute === undefined) {
      (window as any).toggleState.autoExecute = DEFAULT_AUTO_EXECUTE;
    }
    
    const autoExecuteEnabled = (window as any).toggleState.autoExecute === true;
    
    if (CONFIG.debug) {
      console.debug(`Auto-execute ${autoExecuteEnabled ? 'enabled' : 'disabled'} for ${functionName} (${blockId})`);
    }

    // Extract function information for execution tracking
    const invokeMatch = content.match(/<invoke name="([^"]+)"(?:\s+call_id="([^"]+)")?>/i);
    const extractedCallId = invokeMatch && invokeMatch[2] ? invokeMatch[2] : blockId;

    // Create a unique execution ID for this specific auto-execution attempt
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    console.debug(`[AutoExec][${executionId}] Starting auto-execution evaluation for ${functionName} (${blockId})`);

    // Check if the function has already been executed (less strict check to avoid false positives)
    const alreadyExecuted = contentSignature 
      ? getPreviousExecution(functionName, extractedCallId, contentSignature) !== null
      : false;

    if (alreadyExecuted) {
      console.debug(`[AutoExec][${executionId}] Function already executed (storage check), skipping`);
      return true;
    }
    
    // STRICT CHECK: Is auto-execute explicitly disabled?
    if (autoExecuteEnabled !== true) {
      console.debug(`[AutoExec][${executionId}] Auto-execution disabled by user settings for block ${blockId}`);
      return true;
    }
    
    // Skip auto-execution blocks that are already being processed
    // But use a less strict check to avoid false positives
    if (executionTracker.isBlockExecuted(blockId) && executionTracker.getAttempts(blockId) > 0) {
      console.debug(`[AutoExec][${executionId}] Block ${blockId} is already being processed, skipping`);
      return true;
    }

    // Create a timestamp to track when this execution was initiated
    const initiationTime = Date.now();
    
    // At this point, we've passed all checks and can proceed with auto-execution
    // Immediately mark function as scheduled for execution to prevent race conditions
    executionTracker.markFunctionExecuted(extractedCallId, contentSignature, functionName);
    executionTracker.markBlockExecuted(blockId);

    console.debug(`[AutoExec][${executionId}] Setting up auto-execution for ${functionName} (${blockId})`);

    // Store function details for use in the retry mechanism
    const functionDetails = {
      functionName,
      callId: extractedCallId,
      contentSignature,
      params: completeParameters || {}, // Ensure params is an object
      executionId, // Add the execution ID for tracking
      initiationTime, // Add initiation timestamp
    };

    /**
     * Completely rewritten auto-execution setup with more aggressive behavior
     * 1. Uses much faster initial timing to execute as soon as possible
     * 2. Implements a multi-phase approach to ensure DOM stability
     * 3. Uses simpler checks to avoid false-negative detection
     * 4. Falls back to direct dispatch of click events if needed
     */
    
    // Immediately mark this for execution
    executionTracker.markBlockExecuted(blockId);
    if (contentSignature) {
      executionTracker.markFunctionExecuted(extractedCallId, contentSignature, functionName);
    }
    
    // First phase: Direct execution (fastest path)
    const executeDirectly = () => {
      console.log(`[QuickExec] Attempting direct execution for ${functionName}`);
      
      // Directly try to find and click the button immediately
      const button = buttonContainer.querySelector<HTMLButtonElement>('.execute-button');
      if (button && !button.disabled) {
        console.log(`[QuickExec] Found button immediately, clicking...`);
        try {
          button.click();
          return true; // Successfully executed
        } catch (e) {
          console.log(`[QuickExec] Direct click failed:`, e);
          // Fall through to retry mechanism
        }
      } else {
        console.log(`[QuickExec] Button not ready for immediate execution`);
      }
      return false;
    };
    
    // Second phase: More aggressive retry mechanism
    const setupAutoExecution = () => {
      // Create a unique ID for tracking this execution attempt
      const execId = Math.random().toString(36).substring(2, 5);
      
      // Local retry counter for this specific execution attempt
      let retryCount = 0;
      const maxRetries = MAX_AUTO_EXECUTE_ATTEMPTS;
      
      // Create the retry function
      const retry = () => {
        retryCount++;
        
        // Log the attempt
        console.log(`[AutoExec-${execId}] Attempt ${retryCount}/${maxRetries}`);
        
        // Give up if we've tried too many times
        if (retryCount > maxRetries) {
          console.log(`[AutoExec-${execId}] Giving up after ${maxRetries} attempts`);
          return;
        }
        
        // Always check for successful execution first to avoid duplicate executions
        if (getPreviousExecution(functionName, extractedCallId, contentSignature || '')) {
          console.log(`[AutoExec-${execId}] Function already executed in storage, stopping`);
          return;
        }
        
        // Primary strategy: Find the button in the current container
        let executeButton = buttonContainer.querySelector<HTMLButtonElement>('.execute-button');
        
        // Fallback: Look more broadly if not found directly
        if (!executeButton) {
          const allButtons = document.querySelectorAll<HTMLButtonElement>('.execute-button');
          for (const btn of Array.from(allButtons)) {
            // Try to find a button associated with this function
            const parentBlock = btn.closest('.function-block');
            if (parentBlock) {
              const nameEl = parentBlock.querySelector('.function-name-text');
              if (nameEl && nameEl.textContent === functionName) {
                console.log(`[AutoExec-${execId}] Found button via function name match`);
                executeButton = btn;
                break;
              }
              
              // Try to match by block ID
              if (parentBlock.getAttribute('data-block-id') === blockId) {
                console.log(`[AutoExec-${execId}] Found button via block ID match`);
                executeButton = btn;
                break;
              }
            }
          }
        }
        
        // If we found a button, try to click it
        if (executeButton && !executeButton.disabled) {
          console.log(`[AutoExec-${execId}] Found executable button, clicking...`);
          
          try {
            // Use a more forceful click approach
            const clickEvent = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window
            });
            
            executeButton.dispatchEvent(clickEvent);
            console.log(`[AutoExec-${execId}] Button click dispatched successfully`);
            return; // Successfully triggered execution
          } catch (error) {
            console.error(`[AutoExec-${execId}] Error clicking button:`, error);
            // Continue to retry
          }
        } else if (executeButton) {
          console.log(`[AutoExec-${execId}] Found button but it's disabled, waiting...`);
        } else {
          console.log(`[AutoExec-${execId}] Button not found in this attempt`);
        }
        
        // Calculate next retry delay with exponential backoff (capped)
        const baseDelay = 150; // Start with faster retries
        const maxDelay = 1000; // Cap maximum delay
        const delay = Math.min(baseDelay * Math.pow(1.5, retryCount - 1), maxDelay);
        
        // Schedule the next retry
        console.log(`[AutoExec-${execId}] Scheduling retry in ${delay}ms`);
        setTimeout(retry, delay);
      };
      
      // Start the retry process immediately
      retry();
    };
    
    // Try direct execution first
    if (!executeDirectly()) {
      // If direct execution fails, start the retry mechanism after a short delay
      setTimeout(setupAutoExecution, 50);
    }
  }

  // Disable the DOM Observer temporarily to prevent any interference with rendering
  if (domObserver) {
    domObserver.disconnect();
    setTimeout(() => {
      // Re-enable the observer after a short delay to allow rendering to complete
      setupDOMObserver();
    }, 1000);
  }

  return true;
};

/**
 * Create or update a parameter element in the function block
 *
 * @param blockDiv The function block container div
 * @param name The name of the parameter
 * @param value The value of the parameter
 * @param blockId ID of the block
 * @param isNewRender Whether this is a new render
 */
export const createOrUpdateParamElement = (
  container: HTMLDivElement,
  name: string,
  value: any,
  blockId: string,
  isNewRender: boolean,
  isStreaming: boolean = false,
): void => {
  const paramId = `${blockId}-${name}`;

  // First check within the passed container
  let paramNameElement = container.querySelector<HTMLDivElement>(`.param-name[data-param-id="${paramId}"]`);
  let paramValueElement = container.querySelector<HTMLDivElement>(`.param-value[data-param-id="${paramId}"]`);

  // If not found in the container, check the entire document (for backward compatibility)
  if (!paramNameElement) {
    paramNameElement = document.querySelector<HTMLDivElement>(`.param-name[data-param-id="${paramId}"]`);
  }
  if (!paramValueElement) {
    paramValueElement = document.querySelector<HTMLDivElement>(`.param-value[data-param-id="${paramId}"]`);
  }

  // Create parameter name and value elements if they don't exist
  if (!paramNameElement) {
    paramNameElement = document.createElement('div');
    paramNameElement.className = 'param-name';
    paramNameElement.textContent = name;
    paramNameElement.setAttribute('data-param-id', paramId);
    container.appendChild(paramNameElement);
  }

  if (!paramValueElement) {
    paramValueElement = document.createElement('div');
    paramValueElement.className = 'param-value';
    paramValueElement.setAttribute('data-param-id', paramId);
    paramValueElement.setAttribute('data-param-name', name);
    container.appendChild(paramValueElement);
  }

  // Update or set the value display with proper formatting
  const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);

  // For streaming updates: if streaming or already has the streaming attribute
  if (isStreaming || paramValueElement.hasAttribute('data-streaming')) {
    // Get or create a pre element to hold the content for better streaming control
    let preElement = paramValueElement.querySelector('pre');
    if (!preElement) {
      preElement = document.createElement('pre');
      preElement.style.margin = '0';
      preElement.style.padding = '0';
      preElement.style.whiteSpace = 'pre-wrap';
      preElement.style.width = '100%';
      preElement.style.height = '100%';
      preElement.style.fontFamily = 'inherit';
      preElement.style.fontSize = 'inherit';
      preElement.style.lineHeight = '1.5';

      // Clear the parameter value element and append the pre
      paramValueElement.innerHTML = '';
      paramValueElement.appendChild(preElement);
    }

    // Always update content during streaming - this is crucial for real-time updates
    preElement.textContent = displayValue;
  } else {
    // Normal parameter (not streaming): update directly
    paramValueElement.textContent = displayValue;
  }

  // Set the initial value attribute for input elements if needed
  paramValueElement.setAttribute('data-param-value', JSON.stringify(value));

  // Ensure the param value has appropriate styling for scrolling
  if (paramValueElement.scrollHeight > 300) {
    paramValueElement.style.overflow = 'auto';
    paramValueElement.style.scrollBehavior = 'smooth';
  }

  // Clear any existing timeout for this parameter
  const timeoutKey = `streaming-timeout-${paramId}`;
  const existingTimeout = (window as any)[timeoutKey];
  if (existingTimeout) {
    clearTimeout(existingTimeout);
    (window as any)[timeoutKey] = null;
  }

  // Handle streaming state
  if (isStreaming) {
    // Add streaming class to parameter name for visual indicator
    paramNameElement.classList.add('streaming-param-name');
    // Set data-streaming attribute on the parameter value element
    paramValueElement.setAttribute('data-streaming', 'true');

    // Force the parameter value element to have the right styling for streaming
    paramValueElement.style.overflow = 'auto';
    paramValueElement.style.maxHeight = '300px';
    paramValueElement.style.scrollBehavior = 'smooth';

    // Setup auto-scroll for both the container and any pre element inside
    setupAutoScroll(paramValueElement as ParamValueElement);

    const preElement = paramValueElement.querySelector('pre');
    if (preElement) {
      (preElement as any)._userHasScrolled = false; // Reset scroll state
      (preElement as any)._autoScrollToBottom = () => {
        preElement.scrollTop = preElement.scrollHeight;
      };
      (preElement as any)._autoScrollToBottom();
    }

    // Force scroll to bottom for all elements (immediate and after a short delay)
    const scrollToBottom = () => {
      if (
        paramValueElement.scrollHeight > paramValueElement.clientHeight &&
        !(paramValueElement as any)._userHasScrolled
      ) {
        paramValueElement.scrollTop = paramValueElement.scrollHeight;
      }

      if (preElement && preElement.scrollHeight > preElement.clientHeight && !(preElement as any)._userHasScrolled) {
        preElement.scrollTop = preElement.scrollHeight;
      }
    };

    // Execute immediately and after a delay to ensure content has rendered
    scrollToBottom();
    setTimeout(scrollToBottom, 10);
    setTimeout(scrollToBottom, 50);

    // Store timeout in a global property to be able to clear it later
    (window as any)[timeoutKey] = setTimeout(() => {
      if (paramNameElement && document.body.contains(paramNameElement)) {
        paramNameElement.classList.remove('streaming-param-name');
        if (paramValueElement) {
          paramValueElement.removeAttribute('data-streaming');
        }
      }
      (window as any)[timeoutKey] = null;
    }, 3000); // Reduced from 5000ms to 3000ms for more responsive feedback
  } else {
    // If parameter was previously streaming but is now complete, remove the indicator immediately
    if (paramNameElement.classList.contains('streaming-param-name')) {
      paramNameElement.classList.remove('streaming-param-name');
      if (paramValueElement) {
        paramValueElement.removeAttribute('data-streaming');
      }
    }
  }
};
