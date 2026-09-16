import { AdminPage } from '@/app/page';
import {
  getAccountStatus,
  getAccountStatusCredentials,
} from '@/lib/server/domain/account-status';
import { getAutoCheckinStatus } from '@/lib/server/domain/auto-checkin';
import AccountStatus from './account-status';

const AccountStatusPage = async () => {
  const [autoCheckin, credentials, statuses] = await Promise.all([
    getAutoCheckinStatus(),
    getAccountStatusCredentials(),
    getAccountStatus(),
  ]);

  return (
    <AdminPage initialTab="account-status">
      <AccountStatus
        autoCheckin={autoCheckin}
        credentials={credentials as never}
        initialStatuses={statuses}
      />
    </AdminPage>
  );
};

export default AccountStatusPage;
