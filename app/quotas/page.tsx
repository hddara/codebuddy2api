import { AdminPage } from '@/app/page';

import Quotas from './quotas';

const QuotasPage = async () => (
  <AdminPage initialTab="quotas">
    <Quotas />
  </AdminPage>
);

export default QuotasPage;
