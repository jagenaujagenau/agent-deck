import { Effect } from 'effect';
import { nanoid } from 'nanoid';

export interface StreamController {
  cancel: () => void;
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
  isCancelled: () => boolean;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

/**
 * Creates a mock stream that yields chunks token-by-token
 * Supports pause/resume and cancellation
 */
export const createMockStream = (
  response: string,
): Effect.Effect<
  ReadableStream<StreamChunk> & StreamController,
  never,
  never
> =>
  Effect.sync(() => {
    let paused = false;
    let cancelled = false;
    let resumeResolve: (() => void) | null = null;

    const words = response.split(' ');
    let wordIndex = 0;

    const stream = new ReadableStream<StreamChunk>({
      async start(controller) {
        for (let i = 0; i < words.length; i++) {
          // Check if cancelled
          if (cancelled) {
            controller.close();
            return;
          }

          // Wait if paused
          while (paused && !cancelled) {
            await new Promise<void>((resolve) => {
              resumeResolve = resolve;
            });
          }

          if (cancelled) {
            controller.close();
            return;
          }

          // Yield chunk
          const chunk: StreamChunk = {
            content: words[i] + (i < words.length - 1 ? ' ' : ''),
            done: false,
          };
          controller.enqueue(chunk);

          // Simulate delay between words (50-150ms)
          await new Promise((resolve) =>
            setTimeout(resolve, 50 + Math.random() * 100),
          );
        }

        // Final chunk
        if (!cancelled) {
          controller.enqueue({ content: '', done: true });
          controller.close();
        }
      },
    });

    const controller: StreamController = {
      cancel: () => {
        cancelled = true;
        if (resumeResolve) {
          resumeResolve();
        }
      },
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
        if (resumeResolve) {
          resumeResolve();
          resumeResolve = null;
        }
      },
      isPaused: () => paused,
      isCancelled: () => cancelled,
    };

    return Object.assign(stream, controller);
  });

/**
 * Generates a mock assistant response based on user message
 */
export const generateMockResponse = (userMessage: string): string => {
  const responses = [
    `I understand you want me to help with: "${userMessage}". Let me work on that for you.`,
    `Got it! I'll help you with "${userMessage}". This might take a moment.`,
    `Processing your request: "${userMessage}". I'm analyzing the requirements and will provide a solution.`,
    `I see you need help with "${userMessage}". Let me break this down into steps and work through it systematically.`,
  ];

  const baseResponse =
    responses[Math.floor(Math.random() * responses.length)];

  // Add some variation
  const additional = [
    ' First, I need to understand the context better.',
    ' Let me check the current state of the codebase.',
    ' I\'ll start by reviewing the relevant files.',
    ' This requires careful consideration of the architecture.',
  ];

  return baseResponse + additional[Math.floor(Math.random() * additional.length)];
};
