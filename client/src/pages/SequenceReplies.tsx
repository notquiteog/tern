// Every campaign's replies on one page.
//
// The per-campaign tab answers "how did this one go"; this answers "what is
// waiting for me", which is the question somebody running three campaigns
// actually has, and is where the push notification for an interested reply
// lands.
import { Replies } from '../components/Replies';
import { PageHeader } from '../components/ui';

export default function SequenceRepliesPage() {
  return (
    <div className="page">
      <PageHeader title="Replies" sub="What came back from your campaigns, and the next thing to do about each one." />
      <Replies />
    </div>
  );
}
