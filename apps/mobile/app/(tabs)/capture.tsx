import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as api from '@/api';
import { Body, Button, Card, ErrorNote, Screen, Small, styles, usePalette } from '@/ui';

const MAX_TEXT = 20_000;

/**
 * Capture: one large field for anything.
 *
 * A standard multiline text field, so iOS keyboard dictation (the microphone on
 * the keyboard) works as it does in any app. The app itself records no audio
 * and asks for no microphone permission. A pasted link goes in the same field.
 * No record type to choose: the analysis proposes that.
 */
export default function CaptureScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{ edit?: string }>();
  const input = useRef<TextInput>(null);
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<api.Attachment | null>(null);
  const [replaces, setReplaces] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Edit capture" from review arrives with the capture to replace.
  useEffect(() => {
    const edit = typeof params.edit === 'string' ? params.edit : null;
    if (!edit) return;
    setReplaces(edit);
    api
      .getCapture(edit)
      .then((capture) => setText(capture.source.text ?? ''))
      .catch(() => setError('Could not load the capture to edit.'));
  }, [params.edit]);

  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(() => input.current?.focus(), 250);
      return () => clearTimeout(timer);
    }, []),
  );

  const attach = async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'text/plain', 'text/markdown', 'text/x-markdown'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    setAttachment({ name: asset.name, mimeType: asset.mimeType ?? null, uri: asset.uri, file: asset.file ?? null });
  };

  const ready = (text.trim().length > 0 || attachment !== null) && text.length <= MAX_TEXT;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.submitCapture({ text, attachment, replacesCaptureId: replaces });
      setText('');
      setAttachment(null);
      setReplaces(null);
      router.push(`/capture/${result.captureId}`);
    } catch (failure) {
      setError(failure instanceof api.ApiError ? failure.message : 'The capture could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        {replaces ? (
          <Card tone="warn">
            <Small style={{ color: p.warnInk }}>
              Editing a capture. Capturing again replaces it, and its earlier proposal is withdrawn.
            </Small>
          </Card>
        ) : null}

        <TextInput
          ref={input}
          accessibilityLabel="Add anything"
          accessibilityHint="Write, paste a link, or use the keyboard microphone to dictate"
          placeholder="Add anything… who you met, what they said, what to follow up."
          placeholderTextColor={p.muted}
          multiline
          scrollEnabled
          textAlignVertical="top"
          autoCapitalize="sentences"
          autoCorrect
          spellCheck
          keyboardType="default"
          maxLength={MAX_TEXT}
          value={text}
          onChangeText={setText}
          style={[
            styles.body,
            {
              minHeight: 220,
              fontSize: 18,
              lineHeight: 25,
              padding: 14,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: p.line,
              backgroundColor: p.card,
              color: p.ink,
            },
          ]}
        />
        <Small>Tip: tap the microphone on the iPhone keyboard to dictate.</Small>

        {attachment ? (
          <Card>
            <Body>📎 {attachment.name}</Body>
            <Button label="Remove file" variant="quiet" onPress={() => setAttachment(null)} />
          </Card>
        ) : null}

        <ErrorNote message={error} />

        <Button label={replaces ? 'Capture again' : 'Capture'} onPress={submit} busy={busy} disabled={!ready} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Button label="Attach a file" variant="secondary" onPress={attach} disabled={busy} />
          </View>
        </View>
        <Small>
          Your note stays private. Globa 3 reads it, checks the names against what you already know, and shows you what
          it understood. Nothing is researched, and nothing is saved until you confirm. Files: PDF, Markdown or plain text.
        </Small>
      </Screen>
    </KeyboardAvoidingView>
  );
}
