import { AdminPage } from '@/app/page';

import Users from './users';

const UsersPage = async () => (
  <AdminPage initialTab="users">
    <Users />
  </AdminPage>
);

export default UsersPage;
