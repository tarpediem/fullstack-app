import { Request, Response, NextFunction } from 'express';

export const getProfile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = {
      id: req.user?.userId,
      email: req.user?.email,
      name: 'Test User',
      createdAt: new Date().toISOString(),
    };

    res.json({ user });
  } catch (error) {
    next(error);
  }
};

export const updateProfile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { name } = req.body;

    const updatedUser = {
      id: req.user?.userId,
      email: req.user?.email,
      name,
      updatedAt: new Date().toISOString(),
    };

    res.json({
      message: 'Profile updated successfully',
      user: updatedUser,
    });
  } catch (error) {
    next(error);
  }
};