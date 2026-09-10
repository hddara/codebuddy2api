'use client';

import { useAtom } from 'jotai';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { ApiTestProvider, apiTestStateAtom } from '@/app/api-test/api-test';
import {
  showConsoleNotification,
  useConsoleMessages,
} from '@/app/console-notify';
import {
  type ApiTestSuccess,
  formatResult,
  getErrorMessage,
  getSseEventContent,
} from '@/app/console-request';
import { credentialsStateAtom } from '@/app/credentials/credentials';
import { useCredentialLoaders } from '@/app/credentials/use-credential-loaders';
import type { AdminConsoleInitialData } from '@/app/page-data';

interface ApiTestTabControllerProps {
  children: ReactNode;
  initialData?: AdminConsoleInitialData;
}

export const ApiTestTabController = ({
  children,
  initialData,
}: ApiTestTabControllerProps) => {
  const [apiTest, setApiTest] = useAtom(apiTestStateAtom);
  const [credentials] = useAtom(credentialsStateAtom);
  const consoleMessages = useConsoleMessages();
  const { loadCredentialModels, loadCredentials } = useCredentialLoaders();

  const testApi = async () => {
    setApiTest((current) => ({
      ...current,
      result: consoleMessages.requestSending,
      submitting: true,
    }));

    const response = await fetch('/admin-api/chat/completions', {
      body: JSON.stringify({
        credential_filename: apiTest.credentialFilename || undefined,
        messages: [
          {
            content: apiTest.message,
            role: 'user',
          },
        ],
        model: apiTest.model,
        stream: apiTest.stream,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    if (!response.ok) {
      const text = await response.text();

      try {
        const payload = JSON.parse(text) as Record<string, unknown>;

        setApiTest((current) => ({
          ...current,
          result: formatResult(payload),
          submitting: false,
        }));
        showConsoleNotification(
          'error',
          getErrorMessage(payload, consoleMessages.requestFailed),
        );
        return;
      } catch {
        setApiTest((current) => ({
          ...current,
          result: text || consoleMessages.requestFailed,
          submitting: false,
        }));
        showConsoleNotification('error', consoleMessages.requestFailed);
        return;
      }
    }

    if (apiTest.stream && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let streamedResult = '';
      let done = false;

      while (!done) {
        const next = await reader.read();
        done = next.done;
        buffered += decoder.decode(next.value, { stream: !done });
        const events = buffered.split(/\r?\n\r?\n/);
        buffered = events.pop() ?? '';
        const nextContent = events.map(getSseEventContent).join('');

        if (nextContent) {
          streamedResult += nextContent;
          setApiTest((current) => ({
            ...current,
            result: streamedResult,
          }));
        }
      }

      const finalContent = getSseEventContent(buffered);

      if (finalContent) {
        streamedResult += finalContent;
      }

      setApiTest((current) => ({
        ...current,
        result: streamedResult || consoleMessages.requestIdle,
        submitting: false,
      }));
      return;
    }

    const text = await response.text();

    try {
      const payload = JSON.parse(text) as ApiTestSuccess;
      const content = payload.choices?.[0]?.message?.content;

      setApiTest((current) => ({
        ...current,
        result:
          content !== undefined ? formatResult(content) : formatResult(payload),
        submitting: false,
      }));
    } catch {
      setApiTest((current) => ({
        ...current,
        result: text,
        submitting: false,
      }));
    }
  };

  useEffect(() => {
    if (!initialData) {
      void loadCredentialModels();
      void loadCredentials();
    }
  }, [initialData, loadCredentialModels, loadCredentials]);

  return (
    <ApiTestProvider
      value={{
        apiTest,
        credentialOptions:
          initialData?.tab === 'api-test'
            ? initialData.credentials.filter((item) => !item.is_expired)
            : credentials.items.filter((item) => !item.is_expired),
        models:
          credentials.modelRows[apiTest.credentialFilename]?.models ??
          (initialData?.tab === 'api-test'
            ? (initialData.credentialModels[apiTest.credentialFilename] ??
              initialData.models)
            : []),
        onCredentialChange: (value) => {
          const models =
            credentials.modelRows[value]?.models ??
            (initialData?.tab === 'api-test'
              ? (initialData.credentialModels[value] ?? [])
              : []);
          setApiTest((current) => ({
            ...current,
            credentialFilename: value,
            model: models[0] ?? '',
          }));
        },
        onMessageChange: (value) => {
          setApiTest((current) => ({ ...current, message: value }));
        },
        onModelChange: (value) => {
          setApiTest((current) => ({ ...current, model: value }));
        },
        onStreamChange: (value) => {
          setApiTest((current) => ({ ...current, stream: value }));
        },
        onSubmit: () => {
          void testApi();
        },
      }}
    >
      {children}
    </ApiTestProvider>
  );
};
