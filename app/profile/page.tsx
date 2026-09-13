import { AdminPage } from '@/app/page';

import Profile from './profile';

const ProfilePage = async () => (
  <AdminPage initialTab="profile">
    <Profile />
  </AdminPage>
);

export default ProfilePage;
