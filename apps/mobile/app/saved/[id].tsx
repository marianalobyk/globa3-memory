import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import * as api from '@/api';
import { useLoad } from '@/use-load';
import { Button, Card, ErrorNote, Heading, Loading, relativeTime, Row, Screen, Small } from '@/ui';

/**
 * Saved: confirmed in plain words. The records actually written -- read back
 * from the database after the save -- are under "See technical details".
 */
export default function SavedScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error } = useLoad(() => api.getProposal(String(id)));
  const [showRecords, setShowRecords] = useState(false);
  if (!data) return error ? <Screen><ErrorNote message={error} /></Screen> : <Loading label="Reading back" />;
  const name = data.confirmation?.contact?.name ?? null;

  return (
    <Screen>
      <Card tone={data.saved.length > 0 ? 'good' : undefined}>
        <Heading>
          {data.saved.length === 0 ? 'Nothing has been saved yet' : name ? `${name} is saved` : 'Saved'}
        </Heading>
        {data.saved.length > 0 ? (
          <Small>Checked after saving. You will find {name ?? 'it'} in Knowledge and on Today.</Small>
        ) : null}
      </Card>

      {name && data.saved.length > 0 ? (
        <Button label={`Open ${name}`} variant="secondary" onPress={() => router.push({ pathname: '/knowledge', params: { q: name } })} />
      ) : null}
      {data.counts.awaiting > 0 ? (
        <Button label="Back to the capture" variant="secondary" onPress={() => router.replace(`/proposal/${data.id}`)} />
      ) : null}
      <Button label="Done" onPress={() => router.dismissTo('/')} />

      {data.saved.length > 0 ? (
        <Button label={showRecords ? 'Hide technical details' : 'See technical details'} variant="quiet" onPress={() => setShowRecords(!showRecords)} />
      ) : null}
      {showRecords
        ? data.saved.map((record, index) => (
            <Row
              key={`${record.label}-${index}`}
              title={record.label}
              meta={`${record.kind} · ${record.verb.toLowerCase()} ${relativeTime(record.savedAt)}`}
              onPress={() => router.push({ pathname: '/knowledge', params: { q: record.label } })}
            />
          ))
        : null}
    </Screen>
  );
}
