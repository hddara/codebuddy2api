import { AdminPage } from '@/app/page';

import Sessions from './sessions';

const SessionsPage = async () => (
  <AdminPage initialTab="sessions">
    <Sessions />
  </AdminPage>
);

export default SessionsPage;
